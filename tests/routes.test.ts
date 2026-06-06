import { describe, expect, test } from "bun:test";
import { asValue, createContainer } from "awilix";
import { createRoutes } from "../src/api/routes";
import type { Cradle } from "../src/config/container";
import { InMemoryRunStore } from "../src/store/run.store";

const linearCreatedAt = "2025-01-01T00:00:00.000Z";
const linearWebhookTimestamp = 1735689600000;

function createTestRoutes(
  runStore = new InMemoryRunStore({ createRunId: () => "run-1" }),
): ReturnType<typeof createRoutes> {
  const container = createContainer<Cradle>();

  container.register({
    runStore: asValue(runStore),
  });

  return createRoutes(container);
}

describe("routes", () => {
  test("returns health status", async () => {
    const routes = createTestRoutes();

    const response = await routes.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  test("returns runs", async () => {
    const createdAt = new Date("2025-01-01T00:00:00.000Z");
    const runStore = new InMemoryRunStore({
      createRunId: () => "run-1",
      getCurrentDate: () => createdAt,
    });
    const run = await runStore.createRun({ linearIssueId: "issue-1" });
    const routes = createTestRoutes(runStore);

    const response = await routes.fetch(new Request("http://localhost/runs"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runs: [
        {
          ...run,
          createdAt: createdAt.toISOString(),
          updatedAt: createdAt.toISOString(),
        },
      ],
    });
  });

  test("returns not found for unknown routes", async () => {
    const routes = createTestRoutes();

    const response = await routes.fetch(new Request("http://localhost/missing"));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not Found");
  });

  test("creates runs from Linear issue assignment webhooks", async () => {
    const createdAt = new Date("2025-01-01T00:00:00.000Z");
    const runStore = new InMemoryRunStore({
      createRunId: () => "run-1",
      getCurrentDate: () => createdAt,
    });
    const routes = createTestRoutes(runStore);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({
          type: "Issue",
          action: "update",
          createdAt: linearCreatedAt,
          webhookTimestamp: linearWebhookTimestamp,
          data: {
            id: "issue-1",
            assigneeId: "linear-user-1",
            assignee: {
              id: "linear-user-1",
            },
          },
          updatedFrom: {
            assigneeId: null,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      run: {
        id: "run-1",
        linearIssueId: "issue-1",
        state: "queued",
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      },
    });
    await expect(runStore.listRuns()).resolves.toHaveLength(1);
  });

  test("ignores Linear issue updates when assignee did not change", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const routes = createTestRoutes(runStore);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({
          type: "Issue",
          action: "update",
          createdAt: linearCreatedAt,
          webhookTimestamp: linearWebhookTimestamp,
          data: {
            id: "issue-1",
            assigneeId: "linear-user-1",
            assignee: {
              id: "linear-user-1",
            },
          },
          updatedFrom: {
            title: "Old title",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ignored: true });
    await expect(runStore.listRuns()).resolves.toEqual([]);
  });

  test("ignores unrelated Linear webhooks", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const routes = createTestRoutes(runStore);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({
          type: "Comment",
          action: "create",
          data: {
            id: "comment-1",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ignored: true });
    await expect(runStore.listRuns()).resolves.toEqual([]);
  });

  test("rejects invalid Linear webhook JSON", async () => {
    const routes = createTestRoutes();

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: "not-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  test("rejects invalid Linear webhook payloads", async () => {
    const routes = createTestRoutes();

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({ type: "Issue" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid Linear webhook payload",
    });
  });
});
