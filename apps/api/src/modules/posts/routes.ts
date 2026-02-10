import type { FastifyInstance } from "fastify";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
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
  status: "draft" | "scheduled" | "sending" | "sent" | "failed" | "canceled";
  attempts: number;
  lastError?: string;
  sentAt?: string;
  remoteId?: string;
  createdAt: string;
  updatedAt: string;
};

type PostsStore = {
  posts: Map<string, PlannedPost>;
};

const posts = new Map<string, PlannedPost>();

type PostsOptions = Partial<PostsStore> & {
  dataFile?: string;
  persist?: boolean;
  enableScheduler?: boolean;
  schedulerIntervalMs?: number;
  tokenStore?: Map<string, { accessToken: string }>;
  identityStore?: Map<string, unknown>;
  fetchFn?: typeof fetch;
};

const resolveDataFilePath = () => {
  const explicitFile = process.env.FEDICAL_DATA_FILE;
  if (explicitFile) {
    return explicitFile;
  }

  const explicitDir = process.env.FEDICAL_DATA_DIR;
  if (explicitDir) {
    return path.join(explicitDir, "fedical.json");
  }

  return path.join(process.cwd(), "apps", "api", "data", "fedical.json");
};

const loadPostsFromDisk = async (
  filePath: string,
  store: PostsStore,
  warn: (message: string) => void
) => {
  try {
    const raw = await readFile(filePath, "utf8");
    try {
      const data = JSON.parse(raw) as { posts?: PlannedPost[] };
      if (!Array.isArray(data.posts)) {
        return;
      }
      for (const post of data.posts) {
        if (post && typeof post.id === "string") {
          store.posts.set(post.id, post);
        }
      }
    } catch {
      warn(`Failed to parse posts data file. Starting with empty store: ${filePath}`);
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return;
    }
    throw err;
  }
};

const savePostsToDisk = async (filePath: string, store: PostsStore) => {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify({ posts: Array.from(store.posts.values()) }, null, 2);
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, filePath);
};

export async function postsRoutes(app: FastifyInstance, options: PostsOptions = {}) {
  const store: PostsStore = { posts: options.posts ?? posts };
  const shouldPersist = options.persist ?? options.posts === undefined;
  const shouldSchedule = options.enableScheduler ?? options.posts === undefined;
  const schedulerIntervalMs = options.schedulerIntervalMs ?? 20000;
  const dataFilePath = options.dataFile ?? resolveDataFilePath();
  const processingIds = new Set<string>();
  const tokenStore = options.tokenStore;
  const identityStore = options.identityStore;
  const fetchFn = options.fetchFn ?? fetch;

  if (shouldPersist) {
    await loadPostsFromDisk(dataFilePath, store, (message) => app.log.warn(message));
  }

  if (shouldSchedule) {
    setInterval(async () => {
      const now = Date.now();
      const duePosts = Array.from(store.posts.values()).filter((post) => {
        if (post.status !== "scheduled") {
          return false;
        }
        if (processingIds.has(post.id)) {
          return false;
        }
        return new Date(post.scheduledAt).getTime() <= now;
      });

      if (duePosts.length === 0) {
        return;
      }

      for (const post of duePosts) {
        processingIds.add(post.id);
        post.status = "sending";
        post.updatedAt = new Date().toISOString();
        store.posts.set(post.id, post);
        processingIds.delete(post.id);
      }

      if (shouldPersist) {
        try {
          await savePostsToDisk(dataFilePath, store);
        } catch {
          app.log.warn("Failed to persist posts during scheduler tick");
        }
      }

      const sendingPosts = Array.from(store.posts.values()).filter(
        (post) => post.status === "sending"
      );
      if (!tokenStore || sendingPosts.length === 0) {
        return;
      }

      for (const post of sendingPosts) {
        if (processingIds.has(post.id)) {
          continue;
        }
        processingIds.add(post.id);
        const token = tokenStore.get(post.instance);
        if (!token) {
          post.status = "failed";
          post.lastError = "not_logged_in";
          post.attempts += 1;
          post.updatedAt = new Date().toISOString();
          store.posts.set(post.id, post);
          processingIds.delete(post.id);
          continue;
        }

        const sendResult = await sendStatus(post.instance, token.accessToken, post, fetchFn);
        if (sendResult.ok) {
          post.status = "sent";
          post.sentAt = new Date().toISOString();
          post.remoteId = sendResult.remoteId;
          post.lastError = undefined;
        } else {
          post.status = "failed";
          post.lastError = sendResult.error;
          post.attempts += 1;
          if (sendResult.error === "token_rejected") {
            tokenStore.delete(post.instance);
            if (identityStore) {
              identityStore.delete(post.instance);
            }
          }
        }
        post.updatedAt = new Date().toISOString();
        store.posts.set(post.id, post);
        processingIds.delete(post.id);
      }

      if (shouldPersist) {
        try {
          await savePostsToDisk(dataFilePath, store);
        } catch {
          app.log.warn("Failed to persist posts after sending");
        }
      }
    }, schedulerIntervalMs);
  }
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
    if (scheduledDate.getTime() <= Date.now()) {
      return reply.status(400).send({ ok: false, error: "scheduledAt must be in the future" });
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
      status: "scheduled",
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    store.posts.set(post.id, post);

    if (shouldPersist) {
      try {
        await savePostsToDisk(dataFilePath, store);
      } catch {
        return reply.status(500).send({ ok: false, error: "Failed to persist posts" });
      }
    }

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
      const allowedStatus = ["draft", "scheduled", "sending", "sent", "failed", "canceled"] as const;
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
        const nextStatus = updates.status ?? post.status;
        if (nextStatus === "scheduled" && scheduledDate.getTime() <= Date.now()) {
          return reply
            .status(400)
            .send({ ok: false, error: "scheduledAt must be in the future unless status is draft" });
        }
        post.scheduledAt = scheduledDate.toISOString();
      }

      post.updatedAt = new Date().toISOString();
      store.posts.set(post.id, post);

      if (shouldPersist) {
        try {
          await savePostsToDisk(dataFilePath, store);
        } catch {
          return reply.status(500).send({ ok: false, error: "Failed to persist posts" });
        }
      }

      return reply.status(200).send({ ok: true, post });
    }
  );

  app.delete<{ Params: { id: string } }>("/posts/:id", async (request, reply) => {
    const { id } = request.params;
    if (!store.posts.has(id)) {
      return reply.status(404).send({ ok: false, error: "Post not found" });
    }

    store.posts.delete(id);

    if (shouldPersist) {
      try {
        await savePostsToDisk(dataFilePath, store);
      } catch {
        return reply.status(500).send({ ok: false, error: "Failed to persist posts" });
      }
    }

    return reply.status(200).send({ ok: true });
  });
}

export const sendStatus = async (
  origin: string,
  accessToken: string,
  post: Pick<PlannedPost, "text" | "visibility">,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; remoteId: string } | { ok: false; error: string }> => {
  const url = `${origin}/api/v1/statuses`;
  const body = new URLSearchParams({
    status: post.text,
    visibility: post.visibility,
  });

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "authorization": `Bearer ${accessToken}`,
      },
      body: body.toString(),
    });
  } catch {
    return { ok: false, error: "network_error" };
  }

  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "token_rejected" };
  }
  if (!res.ok) {
    return { ok: false, error: `status_post_failed_${res.status}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_response" };
  }

  const obj = data as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  if (!id) {
    return { ok: false, error: "invalid_response" };
  }

  return { ok: true, remoteId: id };
};
