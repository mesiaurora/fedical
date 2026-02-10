import type { FastifyInstance } from "fastify";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateInstanceUrl } from "../shared/validateInstanceUrl.js";

type ConnectBody = {
  instanceUrl: string;
};

type RegisterBody = {
  instanceUrl: string;
};

const scopes = "read write";
const clientName = "Fedical (local)";
const getRedirectUri = () =>
  process.env.FEDICAL_REDIRECT_URI ?? "http://127.0.0.1:3000/auth/callback";
type PendingState = {
  origin: string;
  clientId: string;
  createdAt: number;
  redirectUri?: string;
};
type AccountIdentity = {
  id: string;
  username: string;
  acct: string;
  displayName: string;
  avatar?: string;
};
type ClientRegistration = {
  clientSecret: string;
  redirectUri: string;
};
type TokenRecord = {
  accessToken: string;
  tokenType?: string;
  scope?: string;
  updatedAt: string;
};
type AuthStores = {
  pendingStates: Map<string, PendingState>;
  clientRegistrations: Map<string, ClientRegistration>;
  identities?: Map<string, AccountIdentity>;
  tokens?: Map<string, TokenRecord>;
};
type AuthDeps = Partial<AuthStores> & { fetchFn?: typeof fetch; persist?: boolean; dataFile?: string };

const pendingStates = new Map<string, PendingState>();
const clientRegistrations = new Map<string, ClientRegistration>();
const identities = new Map<string, AccountIdentity>();
const tokens = new Map<string, TokenRecord>();

const resolveAuthDataFilePath = () => {
  const explicitFile = process.env.FEDICAL_AUTH_FILE;
  if (explicitFile) {
    return explicitFile;
  }

  const explicitDir = process.env.FEDICAL_DATA_DIR;
  if (explicitDir) {
    return path.join(explicitDir, "fedical.auth.json");
  }

  return path.join(process.cwd(), "apps", "api", "data", "fedical.auth.json");
};

const loadAuthData = async (
  filePath: string,
  identityStore: Map<string, AccountIdentity>,
  tokenStore: Map<string, TokenRecord>,
  warn: (message: string) => void
) => {
  try {
    const raw = await readFile(filePath, "utf8");
    try {
      const data = JSON.parse(raw) as {
        identities?: Record<string, AccountIdentity>;
        tokens?: Record<string, TokenRecord>;
      };
      if (data.identities && typeof data.identities === "object") {
        for (const [origin, identity] of Object.entries(data.identities)) {
          if (identity && typeof identity.id === "string") {
            identityStore.set(origin, identity);
          }
        }
      }
      if (data.tokens && typeof data.tokens === "object") {
        for (const [origin, token] of Object.entries(data.tokens)) {
          if (token && typeof token.accessToken === "string") {
            tokenStore.set(origin, token);
          }
        }
      }
    } catch {
      warn(`Failed to parse auth data file. Starting with empty auth store: ${filePath}`);
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return;
    }
    throw err;
  }
};

const saveAuthData = async (
  filePath: string,
  identityStore: Map<string, AccountIdentity>,
  tokenStore: Map<string, TokenRecord>
) => {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(
    {
      identities: Object.fromEntries(identityStore.entries()),
      tokens: Object.fromEntries(tokenStore.entries()),
    },
    null,
    2
  );
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, filePath);
};



export async function authRoutes(app: FastifyInstance, options: AuthDeps = {}) {
  const stores: AuthStores = {
    pendingStates: options.pendingStates ?? pendingStates,
    clientRegistrations: options.clientRegistrations ?? clientRegistrations,
    identities: options.identities ?? identities,
    tokens: options.tokens ?? tokens,
  };
  const identityStore = stores.identities ?? identities;
  const tokenStore = stores.tokens ?? tokens;
  const fetchFn = options.fetchFn ?? fetch;

  const shouldPersist = options.persist ?? (options.tokens === undefined && options.identities === undefined);
  const authDataFilePath = options.dataFile ?? resolveAuthDataFilePath();
  if (shouldPersist) {
    await loadAuthData(authDataFilePath, identityStore, tokenStore, (message) =>
      app.log.warn(message)
    );
  }
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
    const redirectUri = getRedirectUri();

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

    stores.clientRegistrations.set(`${origin}::${clientId}`, { clientSecret, redirectUri });

    return reply.status(200).send({
      ok: true,
      instance: origin,
      clientId,
      redirectUri,
      scopes,
    });
  });

/** Generate authorization URL */
  app.get<{ Querystring: { instance: string; clientId: string; scope?: string; redirect?: string } }>("/authorize", async (request, reply) => {
    const { instance, clientId, redirect } = request.query;
    const scope = request.query.scope ?? scopes;

    if (!instance || !clientId) {
      return reply.status(400).send({ ok: false, error: "instanceUrl and clientId are required" });
    }

    const url = validateInstanceUrl(instance);
    if (!url.ok) {
      return reply.status(400).send({ ok: false, error: url.error });
    }

    const registration = stores.clientRegistrations.get(`${url.origin}::${clientId}`);
    if (!registration) {
      return reply.status(400).send({ ok: false, error: "Unknown clientId for this instance" });
    }

    let redirectUri: string | undefined;
    if (redirect) {
      try {
        const redirectUrl = new URL(redirect);
        if (redirectUrl.protocol === "https:" || redirectUrl.protocol === "http:") {
          redirectUri = redirectUrl.toString();
        }
      } catch {
        // ignore invalid redirect
      }
    }

    const state = crypto.randomUUID();
    stores.pendingStates.set(state, {
      origin: url.origin,
      clientId,
      createdAt: Date.now(),
      redirectUri,
    });

    const authorizeUrl = new URL("/oauth/authorize", url.origin);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", registration.redirectUri);
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

    const entry = stores.pendingStates.get(state);
    if (!entry) {
      return reply.status(400).send({ ok: false, error: "Invalid or expired state" });
    }

    const ageMs = Date.now() - entry.createdAt;
    const maxAgeMs = 10 * 60 * 1000;
    if (ageMs > maxAgeMs) {
      stores.pendingStates.delete(state);
      return reply.status(400).send({ ok: false, error: "expired state" });
    }

    stores.pendingStates.delete(state);

    const registration = stores.clientRegistrations.get(`${entry.origin}::${entry.clientId}`);
    if (!registration) {
      return reply.status(400).send({ ok: false, error: "Missing client secret for this clientId" });
    }

    const token = await getToken(
      entry.origin,
      entry.clientId,
      registration.clientSecret,
      registration.redirectUri,
      code,
      fetchFn
    );

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
    const accessToken = typeof tokenObj.access_token === "string" ? tokenObj.access_token : "";
    const tokenType = typeof tokenObj.token_type === "string" ? tokenObj.token_type : undefined;
    const scope = typeof tokenObj.scope === "string" ? tokenObj.scope : undefined;
    if (!accessToken) {
      return reply.status(502).send({ ok: false, error: "Instance returned unexpected token response" });
    }

    const accountResult = await getVerifiedAccount(entry.origin, accessToken, fetchFn);
    if (!accountResult.ok) {
      return reply.status(502).send({ ok: false, error: accountResult.error });
    }

    identityStore.set(entry.origin, accountResult.account);
    tokenStore.set(entry.origin, {
      accessToken,
      tokenType,
      scope,
      updatedAt: new Date().toISOString(),
    });

    if (shouldPersist) {
      try {
        await saveAuthData(authDataFilePath, identityStore, tokenStore);
      } catch {
        return reply.status(500).send({ ok: false, error: "Failed to persist auth data" });
      }
    }

    if (entry.redirectUri) {
      const safeRedirect = entry.redirectUri.replace(/"/g, "%22");
      const payload = JSON.stringify({
        ok: true,
        instance: entry.origin,
        account: accountResult.account,
      }).replace(/</g, "\\u003c");

      reply.type("text/html");
      return reply.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Fedical Login</title>
  </head>
  <body>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, "${safeRedirect}");
        }
      } catch (e) {}
      window.location.href = "${safeRedirect}";
    </script>
  </body>
</html>`);
    }

    return reply.status(200).send({
      ok: true,
      instance: entry.origin,
      account: accountResult.account,
      ...(tokenType ? { token_type: tokenType } : {}),
      ...(scope ? { scope } : {}),
    });
  });

  app.get<{ Querystring: { instance?: string } }>("/me", async (request, reply) => {
    const { instance } = request.query;
    if (!instance) {
      return reply.status(400).send({ ok: false, error: "instance is required" });
    }

    const url = validateInstanceUrl(instance);
    if (!url.ok) {
      return reply.status(400).send({ ok: false, error: url.error });
    }

    const account = identityStore.get(url.origin);
    if (account) {
      return reply.status(200).send({ ok: true, account });
    }

    const token = tokenStore.get(url.origin);
    if (!token) {
      return reply.status(401).send({ ok: false, error: "Not logged in" });
    }

    const accountResult = await getVerifiedAccount(url.origin, token.accessToken, fetchFn);
    if (!accountResult.ok) {
      if (accountResult.error === "token rejected") {
        tokenStore.delete(url.origin);
        identityStore.delete(url.origin);
        if (shouldPersist) {
          await saveAuthData(authDataFilePath, identityStore, tokenStore);
        }
        return reply.status(401).send({ ok: false, error: "Not logged in" });
      }
      return reply.status(502).send({ ok: false, error: accountResult.error });
    }

    identityStore.set(url.origin, accountResult.account);
    if (shouldPersist) {
      await saveAuthData(authDataFilePath, identityStore, tokenStore);
    }

    return reply.status(200).send({ ok: true, account: accountResult.account });
  });

  app.post<{ Body: { instance?: string } }>("/logout", async (request, reply) => {
    const instance = request.body?.instance;
    if (!instance) {
      return reply.status(400).send({ ok: false, error: "instance is required" });
    }

    const url = validateInstanceUrl(instance);
    if (!url.ok) {
      return reply.status(400).send({ ok: false, error: url.error });
    }

    identityStore.delete(url.origin);
    tokenStore.delete(url.origin);
    if (shouldPersist) {
      await saveAuthData(authDataFilePath, identityStore, tokenStore);
    }

    return reply.status(200).send({ ok: true });
  });


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
    redirectUri: string,
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

  const getVerifiedAccount = async (
    origin: string,
    accessToken: string,
    fetchFn: typeof fetch = fetch
  ): Promise<
    | {
      ok: true;
      account: { id: string; username: string; acct: string; displayName: string; avatar?: string };
    }
    | { ok: false; error: string }
  > => {
    const verifyUrl = `${origin}/api/v1/accounts/verify_credentials`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let res: Response;
    try {
      res = await fetchFn(verifyUrl, {
        method: "GET",
        headers: {
          "accept": "application/json",
          "authorization": `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      return { ok: false, error: "Failed to verify account" };
    } finally {
      clearTimeout(timeout);
    }

    const bodyText = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "token rejected" };
    }

    if (!res.ok) {
      const snippet = bodyText.slice(0, 300).trim();
      return {
        ok: false,
        error: `Verify credentials failed (${res.status})${snippet ? `: ${snippet}` : ""}`,
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return { ok: false, error: "Instance returned non-JSON verify response" };
    }

    const obj = data as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : "";
    const username = typeof obj.username === "string" ? obj.username : "";
    const acct = typeof obj.acct === "string" ? obj.acct : "";
    const displayName = typeof obj.display_name === "string" ? obj.display_name : "";
    const avatar = typeof obj.avatar === "string" ? obj.avatar : undefined;
    if (!id || !username || !acct) {
      return { ok: false, error: "Instance returned unexpected verify response" };
    }

    return {
      ok: true,
      account: {
        id,
        username,
        acct,
        displayName,
        ...(avatar ? { avatar } : {}),
      },
    };
  };

} 
