import { describe, expect, test } from "bun:test";
import { PlanningService } from "../src/services/planning.service";
import type { LlmClient } from "../src/services/llm.service";
import type { Run } from "../src/models/run";

function createRun(promptContext?: string): Run {
  const now = new Date("2025-01-01T00:00:00.000Z");

  return {
    id: "run-1",
    agentSessionId: "session-1",
    linearIssueId: "issue-1",
    promptContext,
    state: "planning",
    createdAt: now,
    updatedAt: now,
  };
}

describe("PlanningService", () => {
  test("asks the LLM for a plan using the Linear issue title", async () => {
    const calls: Array<{ system?: string; prompt: string }> = [];
    const llmService: LlmClient = {
      async generateText(input) {
        calls.push(input);
        return "1. Inspect code\n2. Implement change";
      },
    };
    const service = new PlanningService({ llmService });

    const plan = await service.createPlan(
      createRun("<issue><title>Ship the webhook worker</title></issue>"),
    );

    expect(plan).toBe("1. Inspect code\n2. Implement change");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain("autonomous coding agent");
    expect(calls[0]?.prompt).toContain("Ship the webhook worker");
    expect(calls[0]?.prompt).toContain("Return only the plan as a numbered list");
  });

  test("falls back when prompt context has no title", async () => {
    const calls: Array<{ prompt: string }> = [];
    const llmService: LlmClient = {
      async generateText(input) {
        calls.push(input);
        return "1. Clarify issue";
      },
    };
    const service = new PlanningService({ llmService });

    await service.createPlan(createRun());

    expect(calls[0]?.prompt).toContain("the Linear issue");
  });

  test("includes human feedback when revising a plan", async () => {
    const calls: Array<{ prompt: string }> = [];
    const llmService: LlmClient = {
      async generateText(input) {
        calls.push(input);
        return "1. Revised plan";
      },
    };
    const service = new PlanningService({ llmService });

    await service.createPlan({
      ...createRun("<issue><title>Ship the webhook worker</title></issue>"),
      latestPromptBody: "Use the v2 API instead",
    });

    expect(calls[0]?.prompt).toContain("Revise the plan using this human feedback");
    expect(calls[0]?.prompt).toContain("Use the v2 API instead");
  });
});
