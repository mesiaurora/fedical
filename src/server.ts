const Fastify = require("fastify");

const app = Fastify({ logger: true });

app.get("/health", async () => {
  return { ok: true, service: "fedical" };
});

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "127.0.0.1" })
  .then(() => {
    app.log.info(`Listening on http://127.0.0.1:${port}`);
  })
  .catch((err: any) => {
    app.log.error(err);
    process.exit(1);
  });