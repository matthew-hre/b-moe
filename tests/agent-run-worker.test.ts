import { describe, expect, test } from "bun:test";
import { AgentRunWorker, processAgentRun } from "../src/workers/agent-run.worker";
import type { LinearAgentClient } from "../src/services/linear.service";
import type { PlanningClient } from "../src/services/planning.service";
import type { SandboxClient } from "../src/services/sandbox.service";
import type { PiClient } from "../src/services/pi.service";
import type { RedisClient } from "../src/store/redis";
import { InMemoryRunStore } from "../src/store/run.store";

const fakeRedisClient = {} as RedisClient;
const planningService: PlanningClient = {
  async createPlan() {
    return "Plan for Do the thing:\n1. Test plan";
  },
};
const sandboxService: SandboxClient = {
  async createSession(run) {
    return { id: `sandbox-${run.id}`, runId: run.id, workingDirectory: `/tmp/${run.id}` };
  },
  async destroySession() {},
};
const piService: PiClient = {
  async act({ run }) {
    return { summary: `Pi acted on ${run.id}` };
  },
};

describe("processAgentRun", () => {
  test("transitions queued runs through planning to awaiting input and emits progress", async () => {
    const runStore = new InMemoryRunStore({
      createRunId: () => "run-1",
      getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
    });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      linearIssueId: "issue-1",
      requesterUrl: "https://linear.app/acme/profiles/matthew",
      repoUrl: "https://github.com/acme/repo",
      promptContext: "<issue><title>Do the thing</title></issue>",
    });
    const emittedActivities: Array<{ sessionId: string; type: string; body: string | undefined }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(agentSessionId, content) {
        emittedActivities.push({ sessionId: agentSessionId, type: content.type, body: content.body });
      },
      async addPullRequestUrl() {},
    };

    await processAgentRun(run.id, {
      linearService,
      planningService,
      sandboxService,
      piService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({
      state: "awaiting_input",
      pausedFrom: "planning",
      plan: "Plan for Do the thing:\n1. Test plan",
    });
    expect(emittedActivities).toEqual([
      {
        sessionId: "session-1",
        type: "thought",
        body: "I’ve started refining the issue and gathering context.",
      },
      {
        sessionId: "session-1",
        type: "elicitation",
        body: "https://linear.app/acme/profiles/matthew please review this plan:\n\nPlan for Do the thing:\n1. Test plan",
      },
    ]);
  });

  test("continues refining runs into planning", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", repoUrl: "https://github.com/acme/repo" });
    await runStore.transitionRun(run.id, "refining");
    const emittedActivities: Array<{ type: string; body: string | undefined }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ type: content.type, body: content.body });
      },
      async addPullRequestUrl() {},
    };

    await processAgentRun(run.id, {
      linearService,
      planningService,
      sandboxService,
      piService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({
      state: "awaiting_input",
      pausedFrom: "planning",
      plan: "Plan for Do the thing:\n1. Test plan",
    });
    expect(emittedActivities).toEqual([
      { type: "elicitation", body: "Plan for Do the thing:\n1. Test plan" },
    ]);
  });

  test("asks for repository selection before refining", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      repositorySelectionQuestion: "Which repository should I use? Options: frontend, backend.",
    });
    const emittedActivities: Array<{ type: string; body: string | undefined }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ type: content.type, body: content.body });
      },
      async addPullRequestUrl() {},
    };

    await processAgentRun(run.id, {
      linearService,
      planningService,
      sandboxService,
      piService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({
      state: "awaiting_input",
      pausedFrom: "refining",
    });
    expect(emittedActivities).toEqual([
      { type: "elicitation", body: "Which repository should I use? Options: frontend, backend." },
    ]);
  });

  test("moves approved plans into acting", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1" });
    await runStore.transitionRun(run.id, "refining");
    const planningRun = await runStore.transitionRun(run.id, "planning");
    await runStore.saveRun({ ...planningRun, latestPromptBody: "looks good" });
    const emittedActivities: Array<{ type: string; body: string | undefined }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ type: content.type, body: content.body });
      },
      async addPullRequestUrl() {},
    };

    await processAgentRun(run.id, {
      linearService,
      planningService,
      sandboxService,
      piService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({ state: "acting" });
    expect(emittedActivities).toEqual([
      { type: "thought", body: "Plan approved. I’m moving into implementation." },
      { type: "action", body: "Starting implementation in an isolated sandbox." },
      { type: "response", body: "Pi acted on run-1" },
    ]);
  });

  test("replans on non-approval feedback and waits again", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1" });
    await runStore.transitionRun(run.id, "refining");
    const planningRun = await runStore.transitionRun(run.id, "planning");
    await runStore.saveRun({ ...planningRun, latestPromptBody: "Use the v2 API instead" });
    const emittedActivities: Array<{ type: string; body: string | undefined }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ type: content.type, body: content.body });
      },
      async addPullRequestUrl() {},
    };

    await processAgentRun(run.id, {
      linearService,
      planningService,
      sandboxService,
      piService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({
      state: "awaiting_input",
      pausedFrom: "planning",
      latestPromptBody: undefined,
      plan: "Plan for Do the thing:\n1. Test plan",
    });
    expect(emittedActivities).toEqual([
      { type: "elicitation", body: "Plan for Do the thing:\n1. Test plan" },
    ]);
  });
});

describe("AgentRunWorker", () => {
  test("processes BullMQ job data", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1" });
    const linearService: LinearAgentClient = {
      async emitActivity() {},
      async addPullRequestUrl() {},
    };
    const worker = new AgentRunWorker({
      linearService,
      planningService,
      sandboxService,
      piService,
      redisClient: fakeRedisClient,
      runStore,
    });

    await worker.processJob({ data: { runId: run.id } });

    expect((await runStore.getRun(run.id))?.state).toBe("awaiting_input");
  });

  test("processes acting runs with sandbox and Pi", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1" });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "planning");
    await runStore.transitionRun(run.id, "acting");
    const events: string[] = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        events.push(`${content.type}:${content.body}`);
      },
      async addPullRequestUrl() {},
    };
    const sandboxClient: SandboxClient = {
      async createSession() {
        events.push("sandbox:create");
        return { id: "sandbox-1", runId: run.id, workingDirectory: "/tmp/run-1" };
      },
      async destroySession() {
        events.push("sandbox:destroy");
      },
    };
    const piClient: PiClient = {
      async act() {
        events.push("pi:act");
        return { summary: "Done acting" };
      },
    };

    await processAgentRun(run.id, {
      linearService,
      planningService,
      sandboxService: sandboxClient,
      piService: piClient,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(events).toEqual([
      "action:Starting implementation in an isolated sandbox.",
      "sandbox:create",
      "pi:act",
      "response:Done acting",
      "sandbox:destroy",
    ]);
  });
});
