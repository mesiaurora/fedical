import type { FastifyInstance } from "fastify";

type ConnectBody = {
  instanceUrl: string;
};

export async function authRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return {
      ok: true,
      message: "Auth module is working",
    };
  });


  app.post<{ Body: ConnectBody }>("/connect", async (request, reply) => {
    let instanceUrl: URL;

    try {
      instanceUrl = new URL(request.body.instanceUrl);
    } catch {
      return reply.status(400).send({ ok: false, error: "Invalid instanceUrl" });
    }

    if (instanceUrl.protocol !== "https:" && instanceUrl.protocol !== "http:") {
      return reply.status(400).send({ ok: false, error: "instanceUrl must use https or http" });
    }

    // check instance against mastodon instances list
    const origin = instanceUrl.origin;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let res: Response | undefined;
    
    try {
    res = await fetch(`${origin}/api/v1/instance`, { signal: controller.signal }).finally(() => {
      clearTimeout(timeout);
    });

    if (!res.ok) { 
      return reply.status(400).send({ ok: false, error: "instanceUrl is not a valid Mastodon instance" });
    }
    } catch (e) {
      return reply.status(400).send({ ok: false, error: "Failed to connect to instanceUrl" });
    }

    return { ok: true, instance: origin };
  }); 
} 