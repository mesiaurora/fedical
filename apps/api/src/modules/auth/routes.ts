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
      return { ok: false, error: "Invalid instanceUrl" };
    }

    if (instanceUrl.protocol !== "https:" && instanceUrl.protocol !== "http:") {
      return { ok: false, error: "instanceUrl must use https or http" };
    }

    return { ok: true, instance: instanceUrl.origin  };
  }); 
} 