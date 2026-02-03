import type { FastifyInstance } from "fastify";

type ConnectBody = {
  instanceUrl: string;
};

type RegisterBody = {
  instanceUrl: string;
};

const scopes = "read write";
const clientName = "Fedical (local)";
const redirectUri = "http://127.0.0.1:3000/auth/callback";
const pendingStates = new Map<string, { origin: string; clientId: string; createdAt: number }>();
const clientSecrets = new Map<string, string>();



export async function authRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return {
      ok: true,
      message: "Auth module is working",
    };
  });

  /** Connect handshake */
  app.post<{ Body: ConnectBody }>("/connect", async (request, reply) => {
    // validate instanceUrl format    
    const validation = validateInstanceUrl(request.body.instanceUrl);

    if (!validation.ok) {
      return reply.status(400).send({ ok: false, error: validation.error });
    }

    // check instance against mastodon instances list
    const origin = validation.origin;

    const isMastodon = await verifyInstanceUrl(origin);
    if (!isMastodon) {
      return reply.status(400).send({ ok: false, error: "instanceUrl is not a valid Mastodon instance" });
    }

    return reply.status(200).send({ ok: true, instance: origin });
  }); 

  /** Register application on instance */
  app.post<{ Body: RegisterBody }>("/register", async (request, reply) => {
    const url = validateInstanceUrl(request.body.instanceUrl);
    if (!url.ok) {
      return reply.status(400).send({ ok: false, error: url.error });
    }

    const origin = url.origin;

    const isMastodon = await verifyInstanceUrl(origin);
    if (!isMastodon) {
      return reply
        .status(400)
        .send({ ok: false, error: "instanceUrl is not a valid Mastodon instance" });
    }

    const upstreamUrl = `${origin}/api/v1/apps`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let res: Response;
    try {
      res = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: redirectUri,
          scopes: scopes,
        }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      return reply.status(502).send({ ok: false, error: "Failed to reach instance" });
    } finally {
      clearTimeout(timeout);
    }

    let rawText = "";
    try {
      rawText = await res.text();
    } catch {
      return reply.status(502).send({ ok: false, error: "Failed to read instance response" });
    }

    if (!res.ok) {
      const snippet = rawText.slice(0, 300).trim();
      return reply.status(502).send({
        ok: false,
        error: `Instance rejected application registration (${res.status})${snippet ? `: ${snippet}` : ""}`,
      });
    }

    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      return reply.status(502).send({ ok: false, error: "Instance returned non-JSON response" });
    }

    const obj = data as Record<string, unknown>;
    const clientId = typeof obj.client_id === "string" ? obj.client_id : "";
    const clientSecret = typeof obj.client_secret === "string" ? obj.client_secret : "";

    if (!clientId || !clientSecret) {
      return reply.status(502).send({ ok: false, error: "Instance returned unexpected response" });
    }

    clientSecrets.set(`${origin}::${clientId}`, clientSecret);

    return reply.status(200).send({
      ok: true,
      instance: origin,
      clientId,
      redirectUri,
      scopes,
    });
  });

/** Generate authorization URL */
  app.get<{ Querystring: { instance: string; clientId: string; scope?: string } }>("/authorize", async (request, reply) => {
    const { instance, clientId } = request.query;
    const scope = request.query.scope ?? scopes;

    if (!instance || !clientId) {
      return reply.status(400).send({ ok: false, error: "instanceUrl and clientId are required" });
    }

    const url = validateInstanceUrl(instance);
    if (!url.ok) {
      return reply.status(400).send({ ok: false, error: url.error });
    }

    if (!clientSecrets.has(`${url.origin}::${clientId}`)) {
      return reply.status(400).send({ ok: false, error: "Unknown clientId for this instance" });
    }

    const state = crypto.randomUUID();
    pendingStates.set(state, { origin: url.origin, clientId, createdAt: Date.now() });

    const authorizeUrl = new URL("/oauth/authorize", url.origin);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", scope);
    authorizeUrl.searchParams.set("state", state);

    return reply.status(200).send({ ok: true, authorizeUrl: authorizeUrl.toString(), state });
  });

/** Handle OAuth callback */
  app.get<{Querystring: { code: string; state: string }}>("/callback", async (request, reply) => {
    const { code, state } = request.query;

    if (!code || !state) {
      return reply.status(400).send({ ok: false, error: "code and state are required" });
    }

    const entry = pendingStates.get(state);
    if (!entry) {
      return reply.status(400).send({ ok: false, error: "Invalid or expired state" });
    }

    const ageMs = Date.now() - entry.createdAt;
    const maxAgeMs = 10 * 60 * 1000;
    if (ageMs > maxAgeMs) {
      pendingStates.delete(state);
      return reply.status(400).send({ ok: false, error: "expired state" });
    }

    pendingStates.delete(state);

    const clientSecret = clientSecrets.get(`${entry.origin}::${entry.clientId}`);
    if (!clientSecret) {
      return reply.status(400).send({ ok: false, error: "Missing client secret for this clientId" });
    }

    const token = await getToken(entry.origin, entry.clientId, clientSecret, code);

    if (!token.ok) {
      return reply.status(502).send({ ok: false, error: token.error });
    }

    let tokenData: unknown;
    try {
      tokenData = JSON.parse(token.tokenText);
    } catch {
      return reply.status(502).send({ ok: false, error: "Instance returned non-JSON response" });
    }

    const tokenObj = tokenData as Record<string, unknown>;
    const tokenType = typeof tokenObj.token_type === "string" ? tokenObj.token_type : undefined;
    const scope = typeof tokenObj.scope === "string" ? tokenObj.scope : undefined;

    return reply.status(200).send({
      ok: true,
      instance: entry.origin,
      ...(tokenType ? { token_type: tokenType } : {}),
      ...(scope ? { scope } : {}),
    });
  });


  /** Validates instance url and checks it's https or http */
  const validateInstanceUrl = (
    url: string
  ): { ok: true; origin: string } | { ok: false; error: string } => {
    let instanceUrl: URL;

    try {
      instanceUrl = new URL(url);
    } catch {
      return { ok: false, error: "Invalid instanceUrl" };
    }

    if (instanceUrl.protocol !== "https:" && instanceUrl.protocol !== "http:") {
      return { ok: false, error: "instanceUrl must use https or http" };
    }

    return { ok: true, origin: instanceUrl.origin };
  };

  /** Verifies that the instance url is a Mastodon instance by checking /api/v1/instance */
  const verifyInstanceUrl = async (origin: string): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${origin}/api/v1/instance`, {
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timeout);
      });

      return res.ok;
    } catch {
      return false;
    }
  };

  const getToken = async (
    origin: string,
    clientId: string,
    clientSecret: string,
    code: string,
    fetchFn: typeof fetch = fetch
  ): Promise<{ ok: true; tokenText: string } | { ok: false; error: string }> => {
    const tokenUrl = `${origin}/oauth/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let tokenRes: Response;
    try {
      tokenRes = await fetchFn(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      return { ok: false, error: "Failed to reach instance" };
    } finally {
      clearTimeout(timeout);
    }

    const tokenText = await tokenRes.text().catch(() => "");
    if (!tokenRes.ok) {
      const snippet = tokenText.slice(0, 300).trim();
      return {
        ok: false,
        error: `Token exchange failed (${tokenRes.status})${snippet ? `: ${snippet}` : ""}`,
      };
    }

    return { ok: true, tokenText };
  };

} 
