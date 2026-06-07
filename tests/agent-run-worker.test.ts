import { describe, expect, test } from "bun:test";
import { AgentRunWorker, processAgentRun } from "../src/workers/agent-run.worker";
import type { LinearAgentClient } from "../src/services/linear.service";
import type { PlanningClient } from "../src/services/planning.service";
import type { SandboxClient } from "../src/services/sandbox.service";
import type { PiClient } from "../src/services/pi.service";
import type { GitClient } from "../src/services/git.service";
import type { GitHubClient } from "../src/services/github.service";
import type { RedisClient } from "../src/store/redis";
import { InMemoryRunStore } from "../src/store/run.store";

const fakeRedisClient = {} as RedisClient;
const planningService: PlanningClient = {
  async createPlan() {
    return "Plan for Do the thing:\n1. Test plan";
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
};
const piService: PiClient = {
  async act({ run }) {
    return { summary: `Pi acted on ${run.id}`, thoughts: [], stopReason: "stop", toolCallCount: 1 };
  },
};
const gitService: GitClient = {
  async hasChanges() { return true; },
  async describeHead() { return "branch=b-moe/ENG-123"; },
  async commitAll() {},
  async pushBranch() {},
};
const githubService: GitHubClient = {
  async getAccessToken() { return "installation-token-1"; },
  async createPullRequest(input) {
    return { number: 1, url: "https://github.com/acme/repo/pull/1", branchName: input.branchName };
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
      gitService,
      githubService,
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
      gitService,
      githubService,
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
      gitService,
      githubService,
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
    const run = await runStore.createRun({ agentSessionId: "session-1", repoUrl: "https://github.com/acme/repo" });
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
      gitService,
      githubService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({
      state: "pr_opened",
      pullRequest: { url: "https://github.com/acme/repo/pull/1" },
    });
    expect(emittedActivities).toEqual([
      { type: "thought", body: "Plan approved. I’m moving into implementation." },
      { type: "thought", body: "Starting implementation in an isolated sandbox." },
      { type: "thought", body: "Committed any pending workspace changes." },
      { type: "thought", body: "Pushed branch `b-moe/run-1`." },
      { type: "response", body: "Pi acted on run-1\n\nOpened PR: https://github.com/acme/repo/pull/1" },
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
      gitService,
      githubService,
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
      gitService,
      githubService,
      redisClient: fakeRedisClient,
      runStore,
    });

    await worker.processJob({ data: { runId: run.id } });

    expect((await runStore.getRun(run.id))?.state).toBe("awaiting_input");
  });

  test("processes acting runs with sandbox and Pi", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", repoUrl: "https://github.com/acme/repo" });
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
      startProvisioning() {},
      async ensureSession() {
        events.push("sandbox:ensure");
        return {
          id: "sandbox-1",
          runId: run.id,
          containerId: "container-1",
          workingDirectory: "/workspace",
          branchName: "b-moe/issue-1",
        };
      },
      async exec() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async execStream() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async destroySession() {
        events.push("sandbox:destroy");
      },
    };
    const piClient: PiClient = {
      async act() {
        events.push("pi:act");
        return { summary: "Done acting", thoughts: [], stopReason: "stop", toolCallCount: 1 };
      },
    };

    await processAgentRun(run.id, {
      linearService,
      planningService,
      sandboxService: sandboxClient,
      piService: piClient,
      gitService,
      githubService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(events).toEqual([
      "thought:Starting implementation in an isolated sandbox.",
      "sandbox:ensure",
      "pi:act",
      "thought:Committed any pending workspace changes.",
      "thought:Pushed branch `b-moe/issue-1`.",
      "response:Done acting\n\nOpened PR: https://github.com/acme/repo/pull/1",
      "sandbox:destroy",
    ]);
  });

  test("does not open a PR when Pi produces no git changes", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", repoUrl: "https://github.com/acme/repo" });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "planning");
    await runStore.transitionRun(run.id, "acting");
    const emittedActivities: Array<{ type: string; body: string | undefined }> = [];
    let pushed = false;
    let createdPullRequest = false;
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
      gitService: {
        async hasChanges() { return false; },
        async describeHead() { return "branch=b-moe/run-1"; },
        async commitAll() {},
        async pushBranch() { pushed = true; },
      },
      githubService: {
        async getAccessToken() { return "installation-token-1"; },
        async createPullRequest() {
          createdPullRequest = true;
          return { number: 1, url: "https://github.com/acme/repo/pull/1", branchName: "b-moe/run-1" };
        },
      },
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({ state: "acting" });
    expect(pushed).toBe(false);
    expect(createdPullRequest).toBe(false);
    expect(emittedActivities[emittedActivities.length - 1]).toEqual({
      type: "response",
      body: "Pi acted on run-1\n\nPi completed but did not produce any git changes, so I’m not opening a PR yet.",
    });
  });
});
