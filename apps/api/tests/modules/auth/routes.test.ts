import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { authRoutes } from "../../../src/modules/auth/routes.js";

const buildApp = async (fetchFn?: typeof fetch) => {
  const app = Fastify();
  const pendingStates = new Map<string, { origin: string; clientId: string; createdAt: number }>();
  const clientSecrets = new Map<string, string>();
  const identities = new Map<
    string,
    { id: string; username: string; acct: string; displayName: string; avatar?: string }
  >();

  await authRoutes(app, { pendingStates, clientSecrets, fetchFn, identities });
  await app.ready();

  return { app, pendingStates, clientSecrets, identities };
};

const createFetchSequence = (responses: Response[]): typeof fetch => {
  let index = 0;
  return async () => {
    const response = responses[index];
    if (!response) {
      throw new Error("Unexpected fetch call");
    }
    index += 1;
    return response;
  };
};

describe("/authorize", () => {
  it("rejects unknown clientId for instance", async () => {
    const { app } = await buildApp();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/authorize?instance=https://example.com&clientId=unknown",
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        ok: false,
        error: "Unknown clientId for this instance",
      });
    } finally {
      await app.close();
    }
  });

  it("accepts known clientId and returns state with authorizeUrl", async () => {
    const { app, clientSecrets } = await buildApp();
    const origin = "https://example.com";
    const clientId = "client-123";
    clientSecrets.set(`${origin}::${clientId}`, "secret-123");

    try {
      const res = await app.inject({
        method: "GET",
        url: `/authorize?instance=${encodeURIComponent(origin)}&clientId=${clientId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { state?: string; authorizeUrl?: string };

      expect(typeof body.state).toBe("string");
      expect(body.state).toBeTruthy();
      expect(typeof body.authorizeUrl).toBe("string");

      const authorizeUrl = new URL(body.authorizeUrl!);
      expect(authorizeUrl.searchParams.get("client_id")).toBe(clientId);
      expect(authorizeUrl.searchParams.get("state")).toBe(body.state);
    } finally {
      await app.close();
    }
  });
});

describe("/callback", () => {
  it("rejects expired state", async () => {
    const { app, pendingStates } = await buildApp();
    const state = "expired-state";
    pendingStates.set(state, {
      origin: "https://example.com",
      clientId: "client-123",
      createdAt: Date.now() - 11 * 60 * 1000,
    });

    try {
      const res = await app.inject({
        method: "GET",
        url: `/callback?code=fake-code&state=${state}`,
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error?: string };
      expect(body.error).toMatch(/expired|invalid/i);
    } finally {
      await app.close();
    }
  });

  it("exchanges code for token and returns ok", async () => {
    const origin = "https://example.com";
    const clientId = "client-123";
    const state = "fresh-state";
    const fakeFetch = createFetchSequence([
      new Response(
        JSON.stringify({
          access_token: "secret-token-value",
          token_type: "Bearer",
          scope: "read write",
        }),
        { status: 200 }
      ),
      new Response(
        JSON.stringify({
          id: "123",
          username: "alice",
          acct: "alice@example.com",
          display_name: "Alice",
          avatar: "https://example.com/avatar.png",
        }),
        { status: 200 }
      ),
    ]);

    const { app, pendingStates, clientSecrets } = await buildApp(fakeFetch);
    pendingStates.set(state, { origin, clientId, createdAt: Date.now() });
    clientSecrets.set(`${origin}::${clientId}`, "secret-123");

    try {
      const res = await app.inject({
        method: "GET",
        url: `/callback?code=abc&state=${state}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.access_token).toBeUndefined();
      expect(body.account).toEqual({
        id: "123",
        username: "alice",
        acct: "alice@example.com",
        displayName: "Alice",
        avatar: "https://example.com/avatar.png",
      });
      expect(pendingStates.has(state)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns clean error when verify_credentials rejects token", async () => {
    const origin = "https://example.com";
    const clientId = "client-123";
    const state = "fresh-state-401";
    const fakeFetch = createFetchSequence([
      new Response(
        JSON.stringify({
          access_token: "secret-token-value",
          token_type: "Bearer",
          scope: "read write",
        }),
        { status: 200 }
      ),
      new Response("Unauthorized", { status: 401 }),
    ]);

    const { app, pendingStates, clientSecrets } = await buildApp(fakeFetch);
    pendingStates.set(state, { origin, clientId, createdAt: Date.now() });
    clientSecrets.set(`${origin}::${clientId}`, "secret-123");

    try {
      const res = await app.inject({
        method: "GET",
        url: `/callback?code=abc&state=${state}`,
      });

      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body)).toEqual({
        ok: false,
        error: "token rejected",
      });
      expect(pendingStates.has(state)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("/me", () => {
  it("normalizes instance origin when looking up identity", async () => {
    const { app, identities } = await buildApp();
    identities.set("https://mastodon.social", {
      id: "1",
      username: "kea",
      acct: "kea",
      displayName: "Kea",
    });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/me?instance=https://mastodon.social/@kea",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; account?: { username: string } };
      expect(body.ok).toBe(true);
      expect(body.account?.username).toBe("kea");
    } finally {
      await app.close();
    }
  });
});
