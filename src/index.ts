import { createDiContainer } from "./config/container";
import { createRoutes } from "./api/routes";

const PORT = parseInt(process.env.PORT ?? "3000");

const container = createDiContainer();
const app = createRoutes(container);
const { env, redisClient } = container.cradle;

// oxlint-disable-next-line
console.log(
  `[startup] REDIS_HOST=${env.redisHost ?? "unset"} REDIS_PORT=${env.redisPort} redisClient=${redisClient ? "enabled" : "disabled"}`,
);
// oxlint-disable-next-line
console.log(`[startup] LINEAR_CLIENT_ID=${env.linearClientId ? "set" : "unset"} LINEAR_REDIRECT_URI=${env.linearRedirectUri ?? "unset"}`);
// this is like the one necessary log statement
// oxlint-disable-next-line
console.log(`Server running on http://localhost:${PORT}`);

Bun.serve({
  fetch: app.fetch,
  port: PORT,
});
