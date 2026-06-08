import { describe, expect, test } from "bun:test";
import { CommitGenService, type CommitGenClient } from "../src/services/commit-gen.service";
import type { LlmClient } from "../src/services/llm.service";

const noFiles = [{ status: "M", path: "src/index.ts" }];

describe("CommitGenService", () => {
  test("generates structured commit plan from LLM response", async () => {
    const llmResponse = JSON.stringify({
      prTitle: "feat: add user authentication",
      description: "## Summary\n\nAdded user auth.\n\n## Changes\n\n- New auth module",
      commits: [
        { message: "feat(auth): add authentication service", files: ["src/auth/service.ts"] },
        { message: "test: add auth service tests", files: ["tests/auth.test.ts"] },
      ],
    });
    const service = new CommitGenService({
      llmService: createFakeLlm(llmResponse),
    });

    const result = await service.generate({
      linearIssueId: "ENG-123",
      summary: "Added user authentication",
      changedFiles: [
        { status: "A", path: "src/auth/service.ts" },
        { status: "A", path: "tests/auth.test.ts" },
      ],
    });

    expect(result.prTitle).toBe("feat: add user authentication");
    expect(result.description).toContain("## Summary");
    expect(result.commits).toHaveLength(2);
    expect(result.commits[0]).toEqual({
      message: "feat(auth): add authentication service",
      files: ["src/auth/service.ts"],
    });
    expect(result.commits[1]).toEqual({
      message: "test: add auth service tests",
      files: ["tests/auth.test.ts"],
    });
  });

  test("assigns unassigned files to a chore commit", async () => {
    const llmResponse = JSON.stringify({
      prTitle: "feat: add feature",
      description: "## Summary\n\nAdded feature.",
      commits: [
        { message: "feat: add feature module", files: ["src/feature.ts"] },
      ],
    });
    const service = new CommitGenService({
      llmService: createFakeLlm(llmResponse),
    });

    const result = await service.generate({
      linearIssueId: "ENG-456",
      summary: "Added a feature",
      changedFiles: [
        { status: "A", path: "src/feature.ts" },
        { status: "M", path: "src/unassigned.ts" },
      ],
    });

    expect(result.commits).toHaveLength(2);
    expect(result.commits[0].files).toEqual(["src/feature.ts"]);
    expect(result.commits[1].message).toBe("chore: apply remaining changes");
    expect(result.commits[1].files).toEqual(["src/unassigned.ts"]);
  });

  test("falls back when LLM response is not valid JSON", async () => {
    const service = new CommitGenService({
      llmService: createFakeLlm("This is not JSON at all"),
    });

    const result = await service.generate({
      linearIssueId: "ENG-789",
      summary: "Did some work",
      changedFiles: [
        { status: "M", path: "src/index.ts" },
      ],
    });

    expect(result.prTitle).toBe("ENG-789: Did some work");
    expect(result.description).toContain("## Summary");
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].message).toBe("ENG-789: implement changes");
    expect(result.commits[0].files).toEqual(["src/index.ts"]);
  });

  test("falls back when LLM call throws", async () => {
    const service = new CommitGenService({
      llmService: {
        async generateText() { throw new Error("LLM unavailable"); },
      },
    });

    const result = await service.generate({
      linearIssueId: "MAT-10",
      summary: "Implemented commit generation",
      changedFiles: [
        { status: "A", path: "src/services/commit-gen.service.ts" },
      ],
    });

    expect(result.prTitle).toBe("MAT-10: Implemented commit generation");
    expect(result.commits).toHaveLength(1);
  });

  test("falls back when LLM returns empty commit list", async () => {
    const llmResponse = JSON.stringify({
      prTitle: "feat: something",
      description: "## Summary\n\nSome work.",
      commits: [],
    });
    const service = new CommitGenService({
      llmService: createFakeLlm(llmResponse),
    });

    const result = await service.generate({
      linearIssueId: "ENG-100",
      summary: "Did work",
      changedFiles: [{ status: "M", path: "src/index.ts" }],
    });

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].message).toBe("ENG-100: implement changes");
  });

  test("filters out file paths not in the actual changed files list", async () => {
    const llmResponse = JSON.stringify({
      prTitle: "feat: add feature",
      description: "## Summary\n\nAdded feature.",
      commits: [
        { message: "feat: add feature module", files: ["src/feature.ts", "src/hallucinated.ts"] },
      ],
    });
    const service = new CommitGenService({
      llmService: createFakeLlm(llmResponse),
    });

    const result = await service.generate({
      linearIssueId: "ENG-200",
      summary: "Added feature",
      changedFiles: [{ status: "A", path: "src/feature.ts" }],
    });

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].files).toEqual(["src/feature.ts"]);
  });

  test("handles LLM response in markdown fences", async () => {
    const llmRaw = "```json\n" + JSON.stringify({
      prTitle: "fix: resolve timeout bug",
      description: "## Summary\n\nFixed timeout.",
      commits: [{ message: "fix: increase timeout", files: ["src/timeout.ts"] }],
    }) + "\n```";
    const service = new CommitGenService({
      llmService: createFakeLlm(llmRaw),
    });

    const result = await service.generate({
      summary: "Fixed timeout",
      changedFiles: [{ status: "M", path: "src/timeout.ts" }],
    });

    expect(result.prTitle).toBe("fix: resolve timeout bug");
    expect(result.commits).toHaveLength(1);
  });

  test("fallback description includes changed files", async () => {
    const service = new CommitGenService({
      llmService: createFakeLlm("not json"),
    });

    const result = await service.generate({
      summary: "Made changes",
      changedFiles: [
        { status: "M", path: "src/a.ts" },
        { status: "A", path: "src/b.ts" },
      ],
    });

    expect(result.description).toContain("## Changed files");
    expect(result.description).toContain("`src/a.ts`");
    expect(result.description).toContain("`src/b.ts`");
  });

  test("handles no changed files gracefully", async () => {
    const service = new CommitGenService({
      llmService: createFakeLlm("not json"),
    });

    const result = await service.generate({
      summary: "No-op",
      changedFiles: [],
    });

    expect(result.commits).toHaveLength(0);
    expect(result.description).not.toContain("## Changed files");
  });

  test("uses first line of summary as fallback title without issue ID", async () => {
    const service = new CommitGenService({
      llmService: createFakeLlm("not json"),
    });

    const result = await service.generate({
      summary: "First line of summary\nSecond line",
      changedFiles: [{ status: "M", path: "src/x.ts" }],
    });

    expect(result.prTitle).toBe("First line of summary");
  });
});

function createFakeLlm(response: string): LlmClient {
  return {
    async generateText() { return response; },
  };
}
