import { describe, expect, test } from "bun:test";
import { AgentRunWorker, processAgentRun } from "../src/workers/agent-run.worker";
import type { LinearAgentClient } from "../src/services/linear.service";
import type { PlanningClient } from "../src/services/planning.service";
import type { RedisClient } from "../src/store/redis";
import { InMemoryRunStore } from "../src/store/run.store";

const fakeRedisClient = {} as RedisClient;
const planningService: PlanningClient = {
  async createPlan() {
    return "Plan for Do the thing:\n1. Test plan";
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

  test("skips runs that are no longer queued", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1" });
    await runStore.transitionRun(run.id, "refining");
    let emittedActivityCount = 0;
    const linearService: LinearAgentClient = {
      async emitActivity() {
        emittedActivityCount += 1;
      },
      async addPullRequestUrl() {},
    };

    await processAgentRun(run.id, {
      linearService,
      planningService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect((await runStore.getRun(run.id))?.state).toBe("refining");
    expect(emittedActivityCount).toBe(0);
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
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({ state: "acting" });
    expect(emittedActivities).toEqual([
      { type: "thought", body: "Plan approved. I’m moving into implementation." },
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
      redisClient: fakeRedisClient,
      runStore,
    });

    await worker.processJob({ data: { runId: run.id } });

    expect((await runStore.getRun(run.id))?.state).toBe("awaiting_input");
  });
});
