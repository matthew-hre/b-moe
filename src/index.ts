import { createDiContainer } from "./config/container";
import { createRoutes } from "./api/routes";
import { createLogger } from "./logger";

const logger = createLogger("startup");

const PORT = parseInt(process.env.PORT ?? "3000");

const container = createDiContainer();
const app = createRoutes(container);
const { env } = container.cradle;

container.cradle.agentRunWorker.start();

logger.info(
  `REDIS_HOST=${env.redisHost} REDIS_PORT=${env.redisPort} redisClient=enabled`,
);
logger.info(`LINEAR_CLIENT_ID=${env.linearClientId ? "set" : "unset"} LINEAR_REDIRECT_URI=${env.linearRedirectUri ?? "unset"}`);
logger.info(`Server running on http://localhost:${PORT}`);

Bun.serve({
  fetch: app.fetch,
  port: PORT,
});
