import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { authRoutes } from "../../../src/modules/auth/routes.js";

const buildApp = async (fetchFn?: typeof fetch) => {
  const app = Fastify();
  const pendingStates = new Map<string, { origin: string; clientId: string; createdAt: number }>();
  const clientRegistrations = new Map<string, { clientSecret: string; redirectUri: string }>();
  const identities = new Map<
    string,
    { id: string; username: string; acct: string; displayName: string; avatar?: string }
  >();
  const tokens = new Map<
    string,
    { accessToken: string; tokenType?: string; scope?: string; updatedAt: string }
  >();

  await authRoutes(app, { pendingStates, clientRegistrations, fetchFn, identities, tokens });
  await app.ready();

  return { app, pendingStates, clientRegistrations, identities, tokens };
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
    const { app, clientRegistrations } = await buildApp();
    const origin = "https://example.com";
    const clientId = "client-123";
    clientRegistrations.set(`${origin}::${clientId}`, {
      clientSecret: "secret-123",
      redirectUri: "http://127.0.0.1:3000/auth/callback",
    });

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

    const { app, pendingStates, clientRegistrations } = await buildApp(fakeFetch);
    pendingStates.set(state, { origin, clientId, createdAt: Date.now() });
    clientRegistrations.set(`${origin}::${clientId}`, {
      clientSecret: "secret-123",
      redirectUri: "http://127.0.0.1:3000/auth/callback",
    });

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

    const { app, pendingStates, clientRegistrations } = await buildApp(fakeFetch);
    pendingStates.set(state, { origin, clientId, createdAt: Date.now() });
    clientRegistrations.set(`${origin}::${clientId}`, {
      clientSecret: "secret-123",
      redirectUri: "http://127.0.0.1:3000/auth/callback",
    });

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

  it("rehydrates identity when token exists", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "99",
          username: "rehydrate",
          acct: "rehydrate",
          display_name: "Rehydrate User",
        }),
        { status: 200 }
      );
    const { app, tokens, identities } = await buildApp(fakeFetch);
    tokens.set("https://mastodon.social", {
      accessToken: "token-1",
      updatedAt: new Date().toISOString(),
    });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/me?instance=https://mastodon.social",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; account?: { username: string } };
      expect(body.ok).toBe(true);
      expect(body.account?.username).toBe("rehydrate");
      expect(identities.has("https://mastodon.social")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 401 and clears token when token is rejected", async () => {
    const fakeFetch: typeof fetch = async () => new Response("Unauthorized", { status: 401 });
    const { app, tokens, identities } = await buildApp(fakeFetch);
    tokens.set("https://mastodon.social", {
      accessToken: "token-2",
      updatedAt: new Date().toISOString(),
    });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/me?instance=https://mastodon.social",
      });

      expect(res.statusCode).toBe(401);
      expect(tokens.has("https://mastodon.social")).toBe(false);
      expect(identities.has("https://mastodon.social")).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("/logout", () => {
  it("clears token and identity for instance", async () => {
    const { app, tokens, identities } = await buildApp();
    tokens.set("https://mastodon.social", {
      accessToken: "token-3",
      updatedAt: new Date().toISOString(),
    });
    identities.set("https://mastodon.social", {
      id: "2",
      username: "user",
      acct: "user",
      displayName: "User",
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/logout",
        payload: { instance: "https://mastodon.social" },
      });

      expect(res.statusCode).toBe(200);
      expect(tokens.has("https://mastodon.social")).toBe(false);
      expect(identities.has("https://mastodon.social")).toBe(false);
    } finally {
      await app.close();
    }
  });
});
