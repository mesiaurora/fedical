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

  return reply.status(200).send({
    ok: true,
    instance: origin,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
  });
});

app.get<{ Querystring: { instance: string; clientId: string; scope?: string } }>(
  "/authorize",
  async (request, reply) => {
    const { instance, clientId } = request.query;
    const scope = request.query.scope ?? scopes;

    if (!instance || !clientId) {
      return reply.status(400).send({ ok: false, error: "instanceUrl and clientId are required" });
    }

    const url = validateInstanceUrl(instance);
    if (!url.ok) {
      return reply.status(400).send({ ok: false, error: url.error });
    }
    const state = crypto.randomUUID();

    const authorizeUrl = new URL("/oauth/authorize", url.origin);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", scope);
    authorizeUrl.searchParams.set("state", state);

    return reply.status(200).send({ ok: true, authorizeUrl: authorizeUrl.toString(), state });
  }
);



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

} 