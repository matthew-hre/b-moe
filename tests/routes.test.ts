import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { asValue, createContainer } from "awilix";
import { createRoutes } from "../src/api/routes";
import type { Cradle } from "../src/config/container";
import { loadEnv, type Env } from "../src/config/env";
import type { LinearOAuthClient } from "../src/services/linear-oauth.service";
import type { LinearAgentClient } from "../src/services/linear.service";
import { AgentSessionTriggerService } from "../src/services/agent-session-trigger.service";
import { InMemoryRunStore } from "../src/store/run.store";
import { InMemoryLinearInstallStore } from "../src/store/linear-install.store";

const defaultLinearOAuthService: LinearOAuthClient = {
  async installFromAuthorizationCode() {
    return {
      linearAppUserId: "linear-app-user-1",
      expiresIn: 86_399,
      scope: "read write app:assignable app:mentionable",
      hasRefreshToken: true,
    };
  },
};

const noopLinearService: LinearAgentClient = {
  async emitActivity() {},
  async addPullRequestUrl() {},
};

function createTestRoutes(
  runStore = new InMemoryRunStore({ createRunId: () => "run-1" }),
  env: Env = loadEnv({}),
  linearOAuthService = defaultLinearOAuthService,
  linearService: LinearAgentClient = noopLinearService,
): ReturnType<typeof createRoutes> {
  const container = createContainer<Cradle>();

  container.register({
    env: asValue(env),
    redisClient: asValue(undefined),
    linearOAuthService: asValue(linearOAuthService),
    linearService: asValue(linearService),
    runStore: asValue(runStore),
    linearInstallStore: asValue(new InMemoryLinearInstallStore()),
    agentSessionTriggerService: asValue(new AgentSessionTriggerService({ linearService, runStore })),
  });

  return createRoutes(container);
}

function agentSessionCreated(agentSessionId: string, linearIssueId: string): string {
  return JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    agentSession: { id: agentSessionId, issue: { id: linearIssueId } },
    promptContext: "<issue><title>Do the thing</title></issue>",
  });
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
    const run = await runStore.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });
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

  test("redirects to Linear with actor=app for the authorize endpoint", async () => {
    const routes = createTestRoutes(
      new InMemoryRunStore({ createRunId: () => "run-1" }),
      loadEnv({ LINEAR_CLIENT_ID: "client-id-1" }),
    );

    const response = await routes.fetch(
      new Request("http://localhost/oauth/linear/authorize"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("https://linear.app/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id-1");
    expect(location.searchParams.get("actor")).toBe("app");
    expect(location.searchParams.get("scope")).toBe("read,write,app:assignable,app:mentionable");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost/oauth/linear/callback",
    );
  });

  test("reports missing client id on the authorize endpoint", async () => {
    const routes = createTestRoutes();

    const response = await routes.fetch(
      new Request("http://localhost/oauth/linear/authorize"),
    );

    expect(response.status).toBe(500);
    expect(response.json()).resolves.toEqual({
      error: "Missing Linear OAuth configuration",
      missingKeys: ["LINEAR_CLIENT_ID"],
    });
  });

  test("installs Linear app from OAuth callback", async () => {
    const calls: Array<{ code: string; redirectUri: string }> = [];
    const linearOAuthService: LinearOAuthClient = {
      async installFromAuthorizationCode(input) {
        calls.push(input);

        return {
          linearAppUserId: "linear-app-user-1",
          expiresIn: 86_399,
          scope: "read write app:assignable app:mentionable",
          hasRefreshToken: true,
        };
      },
    };
    const routes = createTestRoutes(
      new InMemoryRunStore({ createRunId: () => "run-1" }),
      loadEnv({}),
      linearOAuthService,
    );

    const response = await routes.fetch(
      new Request("http://localhost/oauth/linear/callback?code=oauth-code-1&state=dev-state"),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        code: "oauth-code-1",
        redirectUri: "http://localhost/oauth/linear/callback",
      },
    ]);
    expect(response.json()).resolves.toEqual({
      installed: true,
      linearAppUserId: "linear-app-user-1",
      expiresIn: 86_399,
      scope: "read write app:assignable app:mentionable",
      hasRefreshToken: true,
    });
  });

  test("rejects OAuth callbacks without a code", async () => {
    const routes = createTestRoutes();

    const response = await routes.fetch(
      new Request("http://localhost/oauth/linear/callback?state=dev-state"),
    );

    expect(response.status).toBe(400);
    expect(response.json()).resolves.toEqual({ error: "Missing Linear OAuth code" });
  });

  test("reports Linear OAuth authorization errors", async () => {
    const routes = createTestRoutes();

    const response = await routes.fetch(
      new Request("http://localhost/oauth/linear/callback?error=access_denied"),
    );

    expect(response.status).toBe(400);
    expect(response.json()).resolves.toEqual({
      error: "Linear OAuth authorization failed",
      linearError: "access_denied",
    });
  });

  test("creates runs from AgentSessionEvent created webhooks", async () => {
    const createdAt = new Date("2025-01-01T00:00:00.000Z");
    const runStore = new InMemoryRunStore({
      createRunId: () => "run-1",
      getCurrentDate: () => createdAt,
    });
    const emittedActivities: Array<{ sessionId: string; body: string | undefined; type: string }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(agentSessionId, content) {
        emittedActivities.push({ sessionId: agentSessionId, body: content.body, type: content.type });
      },
      async addPullRequestUrl() {},
    };
    const routes = createTestRoutes(runStore, loadEnv({}), defaultLinearOAuthService, linearService);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: agentSessionCreated("session-1", "issue-1"),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.json()).resolves.toEqual({
      run: {
        id: "run-1",
        agentSessionId: "session-1",
        linearIssueId: "issue-1",
        state: "queued",
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      },
    });
    expect(runStore.listRuns()).resolves.toHaveLength(1);
    expect(emittedActivities).toEqual([
      { sessionId: "session-1", type: "thought", body: "Hi, I'm B-MOE!" },
    ]);
  });

  test("is idempotent for redelivered created webhooks", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const routes = createTestRoutes(runStore);

    await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: agentSessionCreated("session-1", "issue-1"),
      }),
    );
    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: agentSessionCreated("session-1", "issue-1"),
      }),
    );

    expect(response.status).toBe(200);
    expect(runStore.listRuns()).resolves.toHaveLength(1);
  });

  test("acknowledges prompted webhooks for an existing session", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });
    const emittedActivities: Array<{ sessionId: string; body: string | undefined; type: string }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(agentSessionId, content) {
        emittedActivities.push({ sessionId: agentSessionId, body: content.body, type: content.type });
      },
      async addPullRequestUrl() {},
    };
    const routes = createTestRoutes(runStore, loadEnv({}), defaultLinearOAuthService, linearService);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({
          type: "AgentSessionEvent",
          action: "prompted",
          agentSession: { id: "session-1" },
          agentActivity: { body: "Use the v2 API instead" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.json()).resolves.toEqual({
      run: { ...run, createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString() },
    });
    expect(emittedActivities).toEqual([
      { sessionId: "session-1", type: "response", body: "Hi, I'm B-MOE!" },
    ]);
  });

  test("ignores prompted webhooks for an unknown session", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const routes = createTestRoutes(runStore);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({
          type: "AgentSessionEvent",
          action: "prompted",
          agentSession: { id: "session-unknown" },
          agentActivity: { body: "hello?" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.json()).resolves.toEqual({ ignored: true });
    expect(runStore.listRuns()).resolves.toEqual([]);
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
          data: { id: "comment-1" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.json()).resolves.toEqual({ ignored: true });
    expect(runStore.listRuns()).resolves.toEqual([]);
  });

  test("rejects webhooks with an invalid signature when a secret is configured", async () => {
    const routes = createTestRoutes(
      new InMemoryRunStore({ createRunId: () => "run-1" }),
      loadEnv({ LINEAR_WEBHOOK_SECRET: "webhook-secret-1" }),
    );

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        headers: { "linear-signature": "deadbeef" },
        body: agentSessionCreated("session-1", "issue-1"),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.json()).resolves.toEqual({ error: "Invalid Linear webhook signature" });
  });

  test("accepts webhooks with a valid signature when a secret is configured", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const routes = createTestRoutes(
      runStore,
      loadEnv({ LINEAR_WEBHOOK_SECRET: "webhook-secret-1" }),
    );
    const body = agentSessionCreated("session-1", "issue-1");
    const signature = createHmac("sha256", "webhook-secret-1").update(body).digest("hex");

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        headers: { "linear-signature": signature },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(runStore.listRuns()).resolves.toHaveLength(1);
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
    expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  test("rejects invalid Linear webhook payloads", async () => {
    const routes = createTestRoutes();

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({ type: "AgentSessionEvent" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.json()).resolves.toEqual({
      error: "Invalid Linear webhook payload",
    });
  });
});
