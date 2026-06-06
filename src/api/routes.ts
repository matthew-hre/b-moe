import type { AwilixContainer } from "awilix";
import type { Cradle } from "../config/container";

interface Routes {
  fetch(request: Request): Promise<Response>;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

export function createRoutes(container: AwilixContainer<Cradle>): Routes {
  return {
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({ status: "ok" });
      }

      if (url.pathname === "/runs" && request.method === "GET") {
        const runs = await container.cradle.runStore.listRuns();

        return jsonResponse({ runs });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
