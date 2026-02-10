import type { FastifyInstance } from "fastify";
import { validateInstanceUrl } from "../shared/validateInstanceUrl.js";

type CreatePostBody = {
  instance: string;
  scheduledAt: string;
  text: string;
  visibility?: "public" | "unlisted" | "private" | "direct";
};

type UpdatePostBody = Partial<{
  scheduledAt: string;
  text: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  status: "draft" | "scheduled" | "sent" | "canceled";
}>;

type PlannedPost = {
  id: string;
  instance: string;
  scheduledAt: string;
  text: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  status: "draft" | "scheduled" | "sent" | "canceled";
  createdAt: string;
  updatedAt: string;
};

type PostsStore = {
  posts: Map<string, PlannedPost>;
};

const posts = new Map<string, PlannedPost>();

export async function postsRoutes(app: FastifyInstance, options: Partial<PostsStore> = {}) {
  const store: PostsStore = { posts: options.posts ?? posts };
  app.post<{ Body: CreatePostBody }>("/posts", async (request, reply) => {
    const { instance, scheduledAt, text, visibility } = request.body;

    if (!instance || !scheduledAt || !text) {
      return reply.status(400).send({ ok: false, error: "instance, scheduledAt, and text are required" });
    }

    const instanceResult = validateInstanceUrl(instance);
    if (!instanceResult.ok) {
      return reply.status(400).send({ ok: false, error: instanceResult.error });
    }

    const scheduledDate = new Date(scheduledAt);
    if (Number.isNaN(scheduledDate.getTime())) {
      return reply.status(400).send({ ok: false, error: "scheduledAt must be a valid date string" });
    }

    if (text.length > 500) {
      return reply.status(400).send({ ok: false, error: "text must be 500 characters or less" });
    }

    const allowedVisibility = ["public", "unlisted", "private", "direct"] as const;
    const visibilityValue = visibility ?? "public";
    if (!allowedVisibility.includes(visibilityValue)) {
      return reply.status(400).send({ ok: false, error: "visibility must be public, unlisted, private, or direct" });
    }

    const now = new Date();
    const post: PlannedPost = {
      id: crypto.randomUUID(),
      instance: instanceResult.origin,
      scheduledAt: scheduledDate.toISOString(),
      text,
      visibility: visibilityValue,
      status: "draft",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    store.posts.set(post.id, post);

    return reply.status(200).send({ ok: true, post });
  });

  app.get<{ Querystring: { instance?: string; from?: string; to?: string } }>(
    "/posts",
    async (request, reply) => {
      const { instance, from, to } = request.query;

      if (!instance || !from || !to) {
        return reply.status(400).send({ ok: false, error: "instance, from, and to are required" });
      }

      const instanceResult = validateInstanceUrl(instance);
      if (!instanceResult.ok) {
        return reply.status(400).send({ ok: false, error: instanceResult.error });
      }

      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return reply.status(400).send({ ok: false, error: "from and to must be valid date strings" });
      }

      const fromMs = fromDate.getTime();
      const toMs = toDate.getTime();

      const postsInRange = Array.from(store.posts.values())
        .filter((post) => post.instance === instanceResult.origin)
        .filter((post) => {
          const scheduledMs = new Date(post.scheduledAt).getTime();
          return scheduledMs >= fromMs && scheduledMs < toMs;
        })
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

      return reply.status(200).send({ ok: true, posts: postsInRange });
    }
  );

  app.patch<{ Params: { id: string }; Body: UpdatePostBody }>(
    "/posts/:id",
    async (request, reply) => {
      const { id } = request.params;
      const updates = request.body ?? {};
      const post = store.posts.get(id);

      if (!post) {
        return reply.status(404).send({ ok: false, error: "Post not found" });
      }

      const allowedVisibility = ["public", "unlisted", "private", "direct"] as const;
      const allowedStatus = ["draft", "scheduled", "sent", "canceled"] as const;
      const hasUpdates =
        "scheduledAt" in updates || "text" in updates || "visibility" in updates || "status" in updates;

      if (!hasUpdates) {
        return reply.status(400).send({ ok: false, error: "No valid fields to update" });
      }

      if ("text" in updates) {
        if (typeof updates.text !== "string") {
          return reply.status(400).send({ ok: false, error: "text must be a string" });
        }
        if (updates.text.length > 500) {
          return reply.status(400).send({ ok: false, error: "text must be 500 characters or less" });
        }
        post.text = updates.text;
      }

      if ("visibility" in updates) {
        if (!allowedVisibility.includes(updates.visibility ?? "public")) {
          return reply
            .status(400)
            .send({ ok: false, error: "visibility must be public, unlisted, private, or direct" });
        }
        post.visibility = updates.visibility ?? post.visibility;
      }

      if ("status" in updates) {
        if (!allowedStatus.includes(updates.status ?? "draft")) {
          return reply
            .status(400)
            .send({ ok: false, error: "status must be draft, scheduled, sent, or canceled" });
        }
        post.status = updates.status ?? post.status;
      }

      if ("scheduledAt" in updates) {
        if (typeof updates.scheduledAt !== "string") {
          return reply.status(400).send({ ok: false, error: "scheduledAt must be a string" });
        }
        const scheduledDate = new Date(updates.scheduledAt);
        if (Number.isNaN(scheduledDate.getTime())) {
          return reply.status(400).send({ ok: false, error: "scheduledAt must be a valid date string" });
        }
        if (post.status !== "draft" && scheduledDate.getTime() <= Date.now()) {
          return reply
            .status(400)
            .send({ ok: false, error: "scheduledAt must be in the future unless status is draft" });
        }
        post.scheduledAt = scheduledDate.toISOString();
      }

      post.updatedAt = new Date().toISOString();
      store.posts.set(post.id, post);

      return reply.status(200).send({ ok: true, post });
    }
  );

  app.delete<{ Params: { id: string } }>("/posts/:id", async (request, reply) => {
    const { id } = request.params;
    if (!store.posts.has(id)) {
      return reply.status(404).send({ ok: false, error: "Post not found" });
    }

    store.posts.delete(id);
    return reply.status(200).send({ ok: true });
  });
}
