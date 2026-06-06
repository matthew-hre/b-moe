import { createDiContainer } from "./config/container";
import { createRoutes } from "./api/routes";

const PORT = parseInt(process.env.PORT ?? "3000");

const container = createDiContainer();
const app = createRoutes(container);

console.log(`Server running on http://localhost:${PORT}`);

Bun.serve({
  fetch: app.fetch,
  port: PORT,
});
