import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { postsRoutes, sendStatus } from "../../../src/modules/posts/routes.js";

describe("POST /posts", () => {
  it("creates a planned post", async () => {
    const app = Fastify();
    const posts = new Map();
    await postsRoutes(app, { posts });
    await app.ready();

    try {
      const scheduledAt = new Date(Date.now() + 60_000).toISOString();
      const res = await app.inject({
        method: "POST",
        url: "/posts",
        payload: {
          instance: "https://example.com",
          scheduledAt,
          text: "Hello from the future",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; post: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(body.post.instance).toBe("https://example.com");
      expect(body.post.text).toBe("Hello from the future");
      expect(body.post.visibility).toBe("public");
      expect(body.post.status).toBe("scheduled");
      expect(typeof body.post.id).toBe("string");
      expect(typeof body.post.createdAt).toBe("string");
      expect(typeof body.post.updatedAt).toBe("string");
      expect(body.post.scheduledAt).toBe(scheduledAt);
    } finally {
      await app.close();
    }
  });
});

describe("GET /posts", () => {
  it("returns posts in range sorted by scheduledAt", async () => {
    const app = Fastify();
    const posts = new Map();
    await postsRoutes(app, { posts });
    await app.ready();

    const origin = "https://example.com";
    const base = new Date("2026-02-10T12:00:00.000Z").getTime();
    const makePost = (id: string, offsetMinutes: number) => ({
      id,
      instance: origin,
      scheduledAt: new Date(base + offsetMinutes * 60_000).toISOString(),
      text: `post-${id}`,
      visibility: "public" as const,
      status: "draft" as const,
      attempts: 0,
      createdAt: new Date(base).toISOString(),
      updatedAt: new Date(base).toISOString(),
    });

    const postA = makePost("a", 10);
    const postB = makePost("b", 20);
    const postC = makePost("c", 40);
    posts.set(postA.id, postA);
    posts.set(postB.id, postB);
    posts.set(postC.id, postC);

    try {
      const from = new Date(base + 5 * 60_000).toISOString();
      const to = new Date(base + 35 * 60_000).toISOString();
      const res = await app.inject({
        method: "GET",
        url: `/posts?instance=${encodeURIComponent(origin)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; posts: Array<{ id: string }> };
      expect(body.ok).toBe(true);
      expect(body.posts.map((post) => post.id)).toEqual(["a", "b"]);
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /posts/:id", () => {
  it("updates a post and bumps updatedAt", async () => {
    const app = Fastify();
    const posts = new Map();
    await postsRoutes(app, { posts });
    await app.ready();

    const now = Date.now();
    const base = new Date(now - 120_000);
    const post = {
      id: "post-1",
      instance: "https://example.com",
      scheduledAt: new Date(now + 60_000).toISOString(),
      text: "original",
      visibility: "public" as const,
      status: "draft" as const,
      attempts: 0,
      createdAt: base.toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
    };
    posts.set(post.id, post);
    const oldUpdatedAt = post.updatedAt;

    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/posts/${post.id}`,
        payload: { text: "updated text" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; post: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(body.post.text).toBe("updated text");
      expect(new Date(body.post.updatedAt as string).getTime()).toBeGreaterThan(
        new Date(oldUpdatedAt).getTime()
      );
      expect(body.post.instance).toBe(post.instance);
      expect(body.post.createdAt).toBe(post.createdAt);
    } finally {
      await app.close();
    }
  });
});

describe("DELETE /posts/:id", () => {
  it("deletes a post and returns 404 when deleting again", async () => {
    const app = Fastify();
    const posts = new Map();
    await postsRoutes(app, { posts });
    await app.ready();

    const origin = "https://example.com";
    const base = new Date("2026-02-10T12:00:00.000Z").getTime();
    const post = {
      id: "post-delete-1",
      instance: origin,
      scheduledAt: new Date(base + 10 * 60_000).toISOString(),
      text: "delete me",
      visibility: "public" as const,
      status: "draft" as const,
      attempts: 0,
      createdAt: new Date(base).toISOString(),
      updatedAt: new Date(base).toISOString(),
    };
    posts.set(post.id, post);

    try {
      const firstDelete = await app.inject({
        method: "DELETE",
        url: `/posts/${post.id}`,
      });
      expect(firstDelete.statusCode).toBe(200);
      expect(JSON.parse(firstDelete.body)).toEqual({ ok: true });

      const from = new Date(base).toISOString();
      const to = new Date(base + 60 * 60_000).toISOString();
      const listRes = await app.inject({
        method: "GET",
        url: `/posts?instance=${encodeURIComponent(origin)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body) as { posts: Array<{ id: string }> };
      expect(listBody.posts.map((p) => p.id)).not.toContain(post.id);

      const secondDelete = await app.inject({
        method: "DELETE",
        url: `/posts/${post.id}`,
      });
      expect(secondDelete.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("POST /posts validation", () => {
  it("rejects past scheduledAt", async () => {
    const app = Fastify();
    const posts = new Map();
    await postsRoutes(app, { posts });
    await app.ready();

    try {
      const scheduledAt = new Date(Date.now() - 60_000).toISOString();
      const res = await app.inject({
        method: "POST",
        url: "/posts",
        payload: {
          instance: "https://example.com",
          scheduledAt,
          text: "Past post",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error?: string };
      expect(body.error).toMatch(/future/i);
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /posts/:id validation", () => {
  it("rejects invalid scheduledAt", async () => {
    const app = Fastify();
    const posts = new Map();
    await postsRoutes(app, { posts });
    await app.ready();

    const base = new Date();
    const post = {
      id: "post-invalid-date",
      instance: "https://example.com",
      scheduledAt: new Date(base.getTime() + 60_000).toISOString(),
      text: "original",
      visibility: "public" as const,
      status: "draft" as const,
      attempts: 0,
      createdAt: base.toISOString(),
      updatedAt: base.toISOString(),
    };
    posts.set(post.id, post);

    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/posts/${post.id}`,
        payload: { scheduledAt: "not-a-date" },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error?: string };
      expect(body.error).toMatch(/valid date/i);
    } finally {
      await app.close();
    }
  });

  it("rejects past scheduledAt when status is not draft", async () => {
    const app = Fastify();
    const posts = new Map();
    await postsRoutes(app, { posts });
    await app.ready();

    const base = new Date();
    const post = {
      id: "post-past-when-scheduled",
      instance: "https://example.com",
      scheduledAt: new Date(base.getTime() + 60_000).toISOString(),
      text: "original",
      visibility: "public" as const,
      status: "scheduled" as const,
      attempts: 0,
      createdAt: base.toISOString(),
      updatedAt: base.toISOString(),
    };
    posts.set(post.id, post);

    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/posts/${post.id}`,
        payload: { scheduledAt: new Date(Date.now() - 60_000).toISOString() },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error?: string };
      expect(body.error).toMatch(/future/i);
    } finally {
      await app.close();
    }
  });
});

describe("sendStatus", () => {
  it("returns remote id on success", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ id: "123" }), { status: 200 });

    const result = await sendStatus(
      "https://example.com",
      "token",
      { text: "hello", visibility: "public" },
      fakeFetch
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.remoteId).toBe("123");
    }
  });

  it("returns token_rejected on 401", async () => {
    const fakeFetch: typeof fetch = async () => new Response("Unauthorized", { status: 401 });

    const result = await sendStatus(
      "https://example.com",
      "token",
      { text: "hello", visibility: "public" },
      fakeFetch
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("token_rejected");
    }
  });
});
