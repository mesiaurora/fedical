import Fastify from "fastify";
import { authRoutes } from "./modules/auth/routes.js";
import { healthRoutes } from "./modules/health/routes.js";

function buildApp() {
  const app = Fastify({ logger: true });

  app.register(healthRoutes, { prefix: "/health" });
  app.register(authRoutes, { prefix: "/auth" });

  return app;
}

export { buildApp };