import { describe, expect, test } from "bun:test";
import { buildActPrompt, parseActResponse } from "../src/services/pi-prompts";
import type { Run } from "../src/models/run";
import type { SandboxSession } from "../src/services/sandbox.service";

const now = new Date("2025-01-01T00:00:00.000Z");
const sandbox: SandboxSession = {
  id: "sandbox-run-1",
  runId: "run-1",
  containerId: "container-1",
  workingDirectory: "/workspace",
  branchName: "b-moe/eng-123",
};

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    agentSessionId: "session-1",
    linearIssueId: "ENG-123",
    promptContext: "<issue><title>Add webhook handler</title></issue>",
    state: "acting",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("buildActPrompt", () => {
  test("directs execution to research, implement, verify, and ask only when blocked", () => {
    const prompt = buildActPrompt(createRun({
      executionContext: "README.md is missing.",
      latestPromptBody: "Use this BMO image URL.",
    }), sandbox);

    expect(prompt).toContain("implementation mode");
    expect(prompt).toContain("Research, plan internally, implement");
    expect(prompt).toContain("README.md is missing.");
    expect(prompt).toContain("Use this BMO image URL.");
    expect(prompt).toContain("Typecheck -> Lint -> Tests -> Build");
    expect(prompt).toContain("Do not create, rename, switch, or push git branches");
    expect(prompt).toContain("B-MOE will commit, push");
    expect(prompt).toContain("\"kind\":\"needs_input\"");
    expect(prompt).toContain("Documentation and README workflow");
    expect(prompt).toContain("src/config/env.ts");
    expect(prompt).toContain("only mark something as done when you can point to implemented code or tests");
    expect(prompt).toContain("ask for it with `needs_input`");
    expect(prompt).toContain("Do not use broad recursive listings like `ls -R`");
  });
});

describe("parseActResponse", () => {
  test("parses completed JSON summaries", () => {
    expect(parseActResponse([
      "```json",
      "{\"kind\":\"completed\",\"summary\":\"Updated README.md and ran bun test.\"}",
      "```",
    ].join("\n"))).toEqual({
      kind: "completed",
      summary: "Updated README.md and ran bun test.",
    });
  });

  test("parses human input requests", () => {
    expect(parseActResponse("{\"kind\":\"needs_input\",\"question\":\"Which image should I use?\",\"context\":\"README work is blocked on image selection.\"}")).toEqual({
      kind: "needs_input",
      question: "Which image should I use?",
      context: "README work is blocked on image selection.",
    });
  });

  test("treats plain text as a completed summary", () => {
    expect(parseActResponse("Implemented the change.")).toEqual({
      kind: "completed",
      summary: "Implemented the change.",
    });
  });
});
