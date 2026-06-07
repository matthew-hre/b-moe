import { describe, expect, test } from "bun:test";
import { RepositoryService, createBranchName, extractRepositoryInfo } from "../src/services/repository.service";
import { loadEnv } from "../src/config/env";
import type { Run } from "../src/models/run";

function createRun(overrides: Partial<Run> = {}): Run {
  const now = new Date("2025-01-01T00:00:00.000Z");

  return {
    id: "run-1",
    agentSessionId: "session-1",
    state: "queued",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("extractRepositoryInfo", () => {
  test("extracts repo metadata from prompt context tags", () => {
    expect(
      extractRepositoryInfo(
        "<issue><repoUrl>https://github.com/acme/repo</repoUrl><baseBranch>main</baseBranch></issue>",
      ),
    ).toEqual({ url: "https://github.com/acme/repo", baseBranch: "main" });
  });

  test("falls back to the first GitHub URL", () => {
    expect(extractRepositoryInfo("Please use https://github.com/acme/repo for this issue"))
      .toEqual({ url: "https://github.com/acme/repo", baseBranch: undefined });
  });
});

describe("RepositoryService", () => {
  test("resolves configured repository aliases", () => {
    const service = new RepositoryService({
      env: loadEnv({
        REDIS_HOST: "localhost",
        REPOSITORIES_JSON: JSON.stringify({ frontend: "https://github.com/acme/web" }),
      }),
    });

    expect(service.resolve("repo: frontend")).toEqual({
      kind: "resolved",
      repository: { url: "https://github.com/acme/web" },
    });
  });

  test("asks for a repository when aliases exist but none was selected", () => {
    const service = new RepositoryService({
      env: loadEnv({
        REDIS_HOST: "localhost",
        REPOSITORIES_JSON: JSON.stringify({ frontend: "https://github.com/acme/web", backend: "https://github.com/acme/api" }),
      }),
    });

    expect(service.resolve("Build the dashboard")).toEqual({
      kind: "needs_input",
      question: "Which repository should I use? Options: frontend, backend.",
    });
  });

  test("preserves Linear issue identifier casing in branch names", () => {
    expect(createBranchName(createRun({ linearIssueId: "ENG-20" }))).toBe("b-moe/ENG-20");
  });
});
