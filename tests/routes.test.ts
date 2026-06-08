import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { asValue, createContainer } from "awilix";
import { createRoutes } from "../src/api/routes";
import type { Cradle } from "../src/config/container";
import { loadEnv, type Env } from "../src/config/env";
import type { LinearOAuthClient } from "../src/services/linear-oauth.service";
import type { LinearAgentClient } from "../src/services/linear.service";
import { AgentSessionTriggerService } from "../src/services/agent-session-trigger.service";
import type { AgentRunQueue } from "../src/queue/queue";
import type { RepositoryClient } from "../src/services/repository.service";
import type { SandboxClient } from "../src/services/sandbox.service";
import type { PiClient } from "../src/services/pi.service";
import { InMemoryRunStore } from "../src/store/run.store";
import { InMemoryLinearInstallStore } from "../src/store/linear-install.store";
import { InMemorySteeringStore, type SteeringStore } from "../src/store/steering.store";

const defaultLinearOAuthService: LinearOAuthClient = {
  async installFromAuthorizationCode() {
    return {
      linearAppUserId: "linear-app-user-1",
      expiresIn: 86_399,
      scope: "read write app:assignable app:mentionable",
      hasRefreshToken: true,
    };
  },
  async ensureFreshAccessToken() {
    return {
      appUserId: "linear-app-user-1",
      accessToken: "access-token-1",
      scope: "read write app:assignable app:mentionable",
    };
  },
};

const noopLinearService: LinearAgentClient = {
  async emitActivity() {},
  async addPullRequestUrl() {},
};

const noopAgentRunQueue: AgentRunQueue = {
  async enqueueRun() {},
};

const repositoryService: RepositoryClient = {
  resolve(promptContext) {
    return {
      kind: "resolved",
      repository: { url: "https://github.com/acme/repo", baseBranch: promptContext?.includes("main") ? "main" : undefined },
    };
  },
};

const sandboxService: SandboxClient = {
  startProvisioning() {},
  async ensureSession(run) {
    return {
      id: `sandbox-${run.id}`,
      runId: run.id,
      containerId: `container-${run.id}`,
      workingDirectory: "/workspace",
      branchName: `b-moe/${run.linearIssueId ?? run.id}`,
    };
  },
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async execStream() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async destroySession() {},
  async destroyRunSandbox() {},
};

const noopPiService: PiClient = {
  async act() {
    return { kind: "completed", summary: "Done.", stopReason: "stop", toolCallCount: 0 };
  },
  async steer() {
    return false;
  },
};

function createTestRoutes(
  runStore = new InMemoryRunStore({ createRunId: () => "run-1" }),
  env: Env = loadEnv({ REDIS_HOST: "localhost" }),
  linearOAuthService = defaultLinearOAuthService,
  linearService: LinearAgentClient = noopLinearService,
  agentRunQueue: AgentRunQueue = noopAgentRunQueue,
  piService: PiClient = noopPiService,
  steeringStore: SteeringStore = new InMemorySteeringStore(),
): ReturnType<typeof createRoutes> {
  const container = createContainer<Cradle>();

  container.register({
    env: asValue(env),
    redisClient: asValue(undefined),
    linearOAuthService: asValue(linearOAuthService),
    linearService: asValue(linearService),
    agentRunQueue: asValue(agentRunQueue),
    runStore: asValue(runStore),
    linearInstallStore: asValue(new InMemoryLinearInstallStore()),
    piService: asValue(piService),
    steeringStore: asValue(steeringStore),
    repositoryService: asValue(repositoryService),
    agentSessionTriggerService: asValue(new AgentSessionTriggerService({ linearService, runStore, agentRunQueue, repositoryService, sandboxService, piService, steeringStore })),
  });

  return createRoutes(container);
}

function agentSessionCreated(agentSessionId: string, linearIssueId: string): string {
  return JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    agentSession: {
      id: agentSessionId,
      issue: { id: `uuid-${linearIssueId}`, identifier: linearIssueId },
      creator: { name: "Matthew", url: "https://linear.app/acme/profiles/matthew" },
    },
    promptContext: "<issue><title>Do the thing</title><repoUrl>https://github.com/acme/repo</repoUrl><baseBranch>main</baseBranch></issue>",
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
      loadEnv({ LINEAR_CLIENT_ID: "client-id-1", REDIS_HOST: "localhost" }),
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
      async ensureFreshAccessToken() {
        throw new Error("ensureFreshAccessToken is not used in OAuth callback route tests");
      },
    };
    const routes = createTestRoutes(
      new InMemoryRunStore({ createRunId: () => "run-1" }),
      loadEnv({ REDIS_HOST: "localhost" }),
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
    const enqueuedRunIds: string[] = [];
    const linearService: LinearAgentClient = {
      async emitActivity(agentSessionId, content) {
        emittedActivities.push({ sessionId: agentSessionId, body: content.body, type: content.type });
      },
      async addPullRequestUrl() {},
    };
    const agentRunQueue: AgentRunQueue = {
      async enqueueRun(runId) {
        enqueuedRunIds.push(runId);
      },
    };
    const routes = createTestRoutes(
      runStore,
      loadEnv({ REDIS_HOST: "localhost" }),
      defaultLinearOAuthService,
      linearService,
      agentRunQueue,
    );

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
        requesterUrl: "https://linear.app/acme/profiles/matthew",
        requesterName: "Matthew",
        promptContext: "<issue><title>Do the thing</title><repoUrl>https://github.com/acme/repo</repoUrl><baseBranch>main</baseBranch></issue>",
        repoUrl: "https://github.com/acme/repo",
        baseBranch: "main",
        state: "queued",
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      },
    });
    expect(runStore.listRuns()).resolves.toHaveLength(1);
    expect(emittedActivities).toEqual([
      { sessionId: "session-1", type: "thought", body: "Hi, I'm B-MOE!" },
    ]);
    expect(enqueuedRunIds).toEqual(["run-1"]);
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
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "acting");
    const pausedRun = await runStore.transitionRun(run.id, "awaiting_input");
    const emittedActivities: Array<{ sessionId: string; body: string | undefined; type: string }> = [];
    const enqueuedRunIds: string[] = [];
    const linearService: LinearAgentClient = {
      async emitActivity(agentSessionId, content) {
        emittedActivities.push({ sessionId: agentSessionId, body: content.body, type: content.type });
      },
      async addPullRequestUrl() {},
    };
    const agentRunQueue: AgentRunQueue = {
      async enqueueRun(runId) {
        enqueuedRunIds.push(runId);
      },
    };
    const routes = createTestRoutes(runStore, loadEnv({ REDIS_HOST: "localhost" }), defaultLinearOAuthService, linearService, agentRunQueue);

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
    const responseBody = (await response.json()) as { run: Record<string, unknown> };
    expect(responseBody.run).toMatchObject({
      id: pausedRun.id,
      agentSessionId: "session-1",
      linearIssueId: "issue-1",
      state: "acting",
      latestPromptBody: "Use the v2 API instead",
      createdAt: pausedRun.createdAt.toISOString(),
    });
    expect(responseBody.run.pausedFrom).toBeUndefined();
    expect(emittedActivities).toEqual([
      { sessionId: "session-1", type: "response", body: "Got it — I’ll continue with that context." },
    ]);
    expect(enqueuedRunIds).toEqual([run.id]);
  });

  test("steers active Pi sessions from prompted webhooks", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "acting");
    const emittedActivities: Array<{ body: string | undefined; type: string }> = [];
    const steeredMessages: string[] = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ body: content.body, type: content.type });
      },
      async addPullRequestUrl() {},
    };
    const piService: PiClient = {
      async act() {
        return { kind: "completed", summary: "Done.", stopReason: "stop", toolCallCount: 0 };
      },
      async steer(input) {
        steeredMessages.push(input.message);
        return true;
      },
    };
    const steeringStore = new InMemorySteeringStore();
    const routes = createTestRoutes(
      runStore,
      loadEnv({ REDIS_HOST: "localhost" }),
      defaultLinearOAuthService,
      linearService,
      noopAgentRunQueue,
      piService,
      steeringStore,
    );

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
    expect(steeredMessages).toEqual(["Use the v2 API instead"]);
    expect(await steeringStore.drain(run.id)).toEqual([]);
    expect(emittedActivities).toEqual([
      { type: "thought", body: "Got it — I queued that guidance into the active Pi session." },
    ]);
  });

  test("queues prompted webhook steering when no live Pi session is reachable", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "acting");
    const emittedActivities: Array<{ body: string | undefined; type: string }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ body: content.body, type: content.type });
      },
      async addPullRequestUrl() {},
    };
    const steeringStore = new InMemorySteeringStore({
      createMessageId: () => "steering-1",
      getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
    });
    const routes = createTestRoutes(
      runStore,
      loadEnv({ REDIS_HOST: "localhost" }),
      defaultLinearOAuthService,
      linearService,
      noopAgentRunQueue,
      noopPiService,
      steeringStore,
    );

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
    expect(await steeringStore.drain(run.id)).toEqual([
      {
        id: "steering-1",
        runId: run.id,
        body: "Use the v2 API instead",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ]);
    expect(emittedActivities).toEqual([
      { type: "thought", body: "Got it — I queued that guidance for the Pi session." },
    ]);
  });

  test("responds naturally to approval prompts", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "acting");
    await runStore.transitionRun(run.id, "awaiting_input");
    const emittedActivities: Array<{ body: string | undefined; type: string }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ body: content.body, type: content.type });
      },
      async addPullRequestUrl() {},
    };
    const routes = createTestRoutes(runStore, loadEnv({ REDIS_HOST: "localhost" }), defaultLinearOAuthService, linearService);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({
          type: "AgentSessionEvent",
          action: "prompted",
          agentSession: { id: "session-1" },
          agentActivity: { body: "Looks good" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(emittedActivities).toEqual([
      { type: "response", body: "Got it — I’ll continue implementation." },
    ]);
  });

  test("resolves repository selection prompts from aliases", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      repositorySelectionQuestion: "Which repository should I use? Options: frontend, backend.",
    });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "awaiting_input");
    const emittedActivities: Array<{ body: string | undefined; type: string }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ body: content.body, type: content.type });
      },
      async addPullRequestUrl() {},
    };
    const repositoryClient: RepositoryClient = {
      resolve(value) {
        return value?.toLowerCase().includes("frontend")
          ? { kind: "resolved", repository: { url: "https://github.com/acme/web", baseBranch: "main" } }
          : { kind: "needs_input", question: "Which repository should I use? Options: frontend, backend." };
      },
    };
    const agentRunQueue: AgentRunQueue = { async enqueueRun() {} };
    const steeringStore = new InMemorySteeringStore();
    const container = createContainer<Cradle>();
    container.register({
      env: asValue(loadEnv({ REDIS_HOST: "localhost" })),
      redisClient: asValue(undefined),
      linearOAuthService: asValue(defaultLinearOAuthService),
      linearService: asValue(linearService),
      agentRunQueue: asValue(agentRunQueue),
      runStore: asValue(runStore),
      linearInstallStore: asValue(new InMemoryLinearInstallStore()),
      piService: asValue(noopPiService),
      steeringStore: asValue(steeringStore),
      repositoryService: asValue(repositoryClient),
      agentSessionTriggerService: asValue(new AgentSessionTriggerService({ linearService, runStore, agentRunQueue, repositoryService: repositoryClient, sandboxService, piService: noopPiService, steeringStore })),
    });
    const routes = createRoutes(container);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({
          type: "AgentSessionEvent",
          action: "prompted",
          agentSession: { id: "session-1" },
          agentActivity: { body: "frontend" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await runStore.getRun(run.id)).toMatchObject({
      state: "refining",
      repoUrl: "https://github.com/acme/web",
      baseBranch: "main",
      repositorySelectionQuestion: undefined,
    });
    expect(emittedActivities).toEqual([
      { type: "response", body: "Got it — I’ll use that repository." },
    ]);
  });

  test("stops an active run when Linear sends a stop signal", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      repoUrl: "https://github.com/acme/repo",
    });
    await runStore.saveRun({
      ...run,
      sandbox: {
        containerId: "container-run-1",
        status: "ready",
        workspacePrepared: true,
        branchName: "b-moe/run-1",
      },
    });
    const emittedActivities: Array<{ type: string; body: string | undefined }> = [];
    const enqueuedRunIds: string[] = [];
    let destroyedContainerId: string | undefined;
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ type: content.type, body: content.body });
      },
      async addPullRequestUrl() {},
    };
    const agentRunQueue: AgentRunQueue = {
      async enqueueRun(runId) {
        enqueuedRunIds.push(runId);
      },
    };
    const stoppingSandboxService: SandboxClient = {
      ...sandboxService,
      async destroyRunSandbox(stoppedRun) {
        destroyedContainerId = stoppedRun.sandbox?.containerId;
      },
    };
    const steeringStore = new InMemorySteeringStore();
    const container = createContainer<Cradle>();
    container.register({
      env: asValue(loadEnv({ REDIS_HOST: "localhost" })),
      redisClient: asValue(undefined),
      linearOAuthService: asValue(defaultLinearOAuthService),
      linearService: asValue(linearService),
      agentRunQueue: asValue(agentRunQueue),
      runStore: asValue(runStore),
      linearInstallStore: asValue(new InMemoryLinearInstallStore()),
      piService: asValue(noopPiService),
      steeringStore: asValue(steeringStore),
      repositoryService: asValue(repositoryService),
      agentSessionTriggerService: asValue(new AgentSessionTriggerService({
        linearService,
        runStore,
        agentRunQueue,
        repositoryService,
        sandboxService: stoppingSandboxService,
        piService: noopPiService,
        steeringStore,
      })),
    });
    const routes = createRoutes(container);

    const response = await routes.fetch(
      new Request("http://localhost/webhook/linear", {
        method: "POST",
        body: JSON.stringify({
          type: "AgentSessionEvent",
          action: "prompted",
          agentSession: { id: "session-1" },
          agentActivity: { body: "stop", signal: "stop" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await runStore.getRun(run.id)).toMatchObject({ state: "completed" });
    expect(destroyedContainerId).toBe("container-run-1");
    expect(enqueuedRunIds).toEqual([]);
    expect(emittedActivities).toEqual([
      { type: "response", body: "Stopped — I won't continue this run." },
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
      loadEnv({ LINEAR_WEBHOOK_SECRET: "webhook-secret-1", REDIS_HOST: "localhost" }),
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
      loadEnv({ LINEAR_WEBHOOK_SECRET: "webhook-secret-1", REDIS_HOST: "localhost" }),
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
