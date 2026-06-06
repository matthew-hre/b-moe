import type { AwilixContainer } from "awilix";
import type { Cradle } from "../config/container";

interface Routes {
  fetch(request: Request): Response;
}

export function createRoutes(_container: AwilixContainer<Cradle>): Routes {
  return {
    fetch(request: Request) {
      const url = new URL(request.url);

      if (url.pathname === "/health" && request.method === "GET") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
