import { describe, expect, test } from "bun:test";
import {
  InvalidRunStateTransitionError,
  type Run,
  type RunState,
  canTransitionRun,
  transitionRun,
} from "../src/models/run";

function createRun(state: RunState = "queued"): Run {
  const createdAt = new Date("2025-01-01T00:00:00.000Z");

  return {
    id: "run-1",
    linearIssueId: "issue-1",
    state,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("run state machine", () => {
  test.each([
    ["queued", "refining"],
    ["refining", "planning"],
    ["planning", "acting"],
    ["acting", "pr_opened"],
    ["pr_opened", "monitoring"],
    ["monitoring", "responding"],
    ["responding", "monitoring"],
    ["monitoring", "completed"],
  ] satisfies Array<[RunState, RunState]>)
    ("allows %s to %s", (currentState, nextState) => {
      expect(canTransitionRun(currentState, nextState)).toBe(true);
    });

  test.each([
    ["queued", "acting"],
    ["refining", "responding"],
    ["planning", "monitoring"],
    ["acting", "completed"],
    ["completed", "monitoring"],
  ] satisfies Array<[RunState, RunState]>)
    ("rejects %s to %s", (currentState, nextState) => {
      expect(canTransitionRun(currentState, nextState)).toBe(false);
      expect(() => transitionRun(createRun(currentState), nextState)).toThrow(
        InvalidRunStateTransitionError,
      );
    });

  test("returns an updated immutable run when transitioning", () => {
    const run = createRun("queued");
    const transitionedAt = new Date("2025-01-01T01:00:00.000Z");

    const transitionedRun = transitionRun(run, "refining", transitionedAt);

    expect(transitionedRun).toEqual({
      ...run,
      state: "refining",
      updatedAt: transitionedAt,
    });
    expect(run.state).toBe("queued");
  });

  test("supports the monitoring and responding review loop", () => {
    const monitoringRun = createRun("monitoring");

    const respondingRun = transitionRun(monitoringRun, "responding");
    const nextMonitoringRun = transitionRun(respondingRun, "monitoring");

    expect(respondingRun.state).toBe("responding");
    expect(nextMonitoringRun.state).toBe("monitoring");
  });

  test("sets completedAt when moving to completed", () => {
    const run = createRun("monitoring");
    const completedAt = new Date("2025-01-02T00:00:00.000Z");

    const completedRun = transitionRun(run, "completed", completedAt);

    expect(completedRun.state).toBe("completed");
    expect(completedRun.updatedAt).toBe(completedAt);
    expect(completedRun.completedAt).toBe(completedAt);
  });
});
