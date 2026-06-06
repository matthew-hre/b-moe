import { describe, expect, test } from "bun:test";
import { asValue, createContainer } from "awilix";
import { createRoutes } from "../src/api/routes";
import type { Cradle } from "../src/config/container";
import { InMemoryRunStore } from "../src/store/run.store";

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
    expect(response.json()).resolves.toEqual({ status: "ok" });
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
    expect(response.json()).resolves.toEqual({
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
    expect(response.text()).resolves.toBe("Not Found");
  });
});
