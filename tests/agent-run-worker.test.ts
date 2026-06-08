import { describe, expect, test } from "bun:test";
import { AgentRunWorker, processAgentRun } from "../src/workers/agent-run.worker";
import type { LinearAgentClient } from "../src/services/linear.service";
import type { SandboxClient } from "../src/services/sandbox.service";
import type { PiClient } from "../src/services/pi.service";
import type { GitClient } from "../src/services/git.service";
import type { GitHubClient } from "../src/services/github.service";
import type { RedisClient } from "../src/store/redis";
import { InMemoryRunStore } from "../src/store/run.store";

const fakeRedisClient = {} as RedisClient;
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
const piService: PiClient = {
  async act({ run }) {
    return { kind: "completed", summary: `Pi acted on ${run.id}`, stopReason: "stop", toolCallCount: 1 };
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
  test("transitions queued runs directly into acting and opens a PR", async () => {
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
    expect(emittedActivities.slice(0, 1)).toEqual([
      {
        sessionId: "session-1",
        type: "thought",
        body: "Starting repository research and implementation in Pi.",
      },
    ]);
  });

  test("continues refining runs into acting", async () => {
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
      sandboxService,
      piService,
      gitService,
      githubService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({
      state: "pr_opened",
    });
    expect(emittedActivities[0]).toEqual({ type: "thought", body: "Starting repository research and implementation in Pi." });
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

  test("pauses acting runs when Pi asks for human input", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      requesterUrl: "https://linear.app/acme/profiles/matthew",
      repoUrl: "https://github.com/acme/repo",
    });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "acting");
    const emittedActivities: Array<{ type: string; body: string | undefined }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({ type: content.type, body: content.body });
      },
      async addPullRequestUrl() {},
    };
    const piClient: PiClient = {
      async act() {
        return {
          kind: "needs_input",
          question: "Which image URL should I use for BMO?",
          context: "Need the image before editing README.md.",
          stopReason: "stop",
          toolCallCount: 2,
          sessionId: "pi-session-1",
        };
      },
    };
    let destroyed = false;

    await processAgentRun(run.id, {
      linearService,
      sandboxService: { ...sandboxService, async destroySession() { destroyed = true; } },
      piService: piClient,
      gitService,
      githubService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(await runStore.getRun(run.id)).toMatchObject({
      state: "awaiting_input",
      pausedFrom: "acting",
      executionContext: "Need the image before editing README.md.",
      piSessionId: "pi-session-1",
    });
    expect(destroyed).toBe(false);
    expect(emittedActivities).toEqual([
      {
        type: "elicitation",
        body: "https://linear.app/acme/profiles/matthew Which image URL should I use for BMO?",
      },
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
      sandboxService,
      piService,
      gitService,
      githubService,
      redisClient: fakeRedisClient,
      runStore,
    });

    await worker.processJob({ data: { runId: run.id } });

    expect((await runStore.getRun(run.id))?.state).toBe("pr_opened");
  });

  test("processes acting runs with sandbox and Pi", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", repoUrl: "https://github.com/acme/repo" });
    await runStore.transitionRun(run.id, "refining");
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
        return { kind: "completed", summary: "Done acting", stopReason: "stop", toolCallCount: 1 };
      },
    };

    await processAgentRun(run.id, {
      linearService,
      sandboxService: sandboxClient,
      piService: piClient,
      gitService,
      githubService,
      redisClient: fakeRedisClient,
      runStore,
    });

    expect(events).toEqual([
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

    expect(await runStore.getRun(run.id)).toMatchObject({ state: "completed" });
    expect(pushed).toBe(false);
    expect(createdPullRequest).toBe(false);
    expect(emittedActivities[emittedActivities.length - 1]).toEqual({
      type: "response",
      body: "Pi acted on run-1\n\nPi completed but did not produce any git changes, so I'm not opening a PR yet.",
    });
  });

  test("emits an error activity and completes the run when implementation fails", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const run = await runStore.createRun({ agentSessionId: "session-1", repoUrl: "https://github.com/acme/repo" });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "acting");
    const emittedActivities: Array<{ type: string; body: string | undefined; error: string | undefined }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(_agentSessionId, content) {
        emittedActivities.push({
          type: content.type,
          body: content.body,
          error: content.error,
        });
      },
      async addPullRequestUrl() {},
    };

    await expect(processAgentRun(run.id, {
      linearService,
      sandboxService: {
        ...sandboxService,
        async ensureSession() {
          throw new Error("sandbox unavailable");
        },
      },
      piService,
      gitService,
      githubService,
      redisClient: fakeRedisClient,
      runStore,
    })).rejects.toThrow("ensure sandbox failed: sandbox unavailable");

    expect(await runStore.getRun(run.id)).toMatchObject({ state: "completed" });
    expect(emittedActivities).toEqual([
      {
        type: "error",
        body: "ensure sandbox failed: sandbox unavailable",
        error: "ensure sandbox failed: sandbox unavailable",
      },
    ]);
  });
});
