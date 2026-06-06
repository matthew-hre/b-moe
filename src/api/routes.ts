import type { AwilixContainer } from "awilix";
import type { Cradle } from "../config/container";
import { getAssignedLinearIssueId, LinearWebhookEventSchema } from "../models/linear";

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

      if (url.pathname === "/webhook/linear" && request.method === "POST") {
        let body: unknown;

        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
        }

        const parseResult = LinearWebhookEventSchema.safeParse(body);

        if (!parseResult.success) {
          return jsonResponse({ error: "Invalid Linear webhook payload" }, { status: 400 });
        }

        const linearIssueId = getAssignedLinearIssueId(parseResult.data);

        if (!linearIssueId) {
          return jsonResponse({ ignored: true });
        }

        const run = await container.cradle.runStore.createRun({ linearIssueId });

        return jsonResponse({ run });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
