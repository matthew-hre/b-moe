import { describe, expect, test } from "bun:test";
import { processAgentRun } from "../src/workers/agent-run.worker";
import type { LinearAgentClient } from "../src/services/linear.service";
import { InMemoryRunStore } from "../src/store/run.store";

describe("processAgentRun", () => {
  test("transitions queued runs to refining and emits progress", async () => {
    const runStore = new InMemoryRunStore({
      createRunId: () => "run-1",
      getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
    });
    const run = await runStore.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });
    const emittedActivities: Array<{ sessionId: string; type: string; body: string | undefined }> = [];
    const linearService: LinearAgentClient = {
      async emitActivity(agentSessionId, content) {
        emittedActivities.push({ sessionId: agentSessionId, type: content.type, body: content.body });
      },
      async addPullRequestUrl() {},
    };

    await processAgentRun(run.id, { linearService, runStore });

    expect((await runStore.getRun(run.id))?.state).toBe("refining");
    expect(emittedActivities).toEqual([
      {
        sessionId: "session-1",
        type: "thought",
        body: "I’ve started refining the issue and gathering context.",
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

    await processAgentRun(run.id, { linearService, runStore });

    expect((await runStore.getRun(run.id))?.state).toBe("refining");
    expect(emittedActivityCount).toBe(0);
  });
});
