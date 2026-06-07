import { describe, expect, test } from "bun:test";
import { RepositoryService, extractRepositoryInfo } from "../src/services/repository.service";
import type { CommandRunner, FileSystemClient } from "../src/services/repository.service";
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

  test("returns a per-run workspace path", async () => {
    const commands: Array<{ command: readonly string[]; cwd?: string; env?: Record<string, string> }> = [];
    const service = new RepositoryService({
      env: loadEnv({ REDIS_HOST: "localhost", REPO_BASE_PATH: "/var/b-moe/repos" }),
      commandRunner: {
        async run(command, options) {
          commands.push({ command, cwd: options?.cwd, env: options?.env });
        },
      },
      fileSystem: { async ensureDirectory() {}, async exists() { return false; } },
    });

    await expect(service.getWorkspace(createRun({ linearIssueId: "ENG-123", repoUrl: "https://github.com/acme/repo", baseBranch: "main" })))
      .resolves.toEqual({
        repoUrl: "https://github.com/acme/repo",
        baseBranch: "main",
        branchName: "b-moe/ENG-123",
        path: "/var/b-moe/repos/run-1",
      });
    expect(commands).toEqual([
      { command: ["git", "clone", "https://github.com/acme/repo", "/var/b-moe/repos/run-1"], cwd: undefined, env: undefined },
      { command: ["git", "checkout", "main"], cwd: "/var/b-moe/repos/run-1", env: undefined },
      { command: ["git", "pull", "--ff-only", "origin", "main"], cwd: "/var/b-moe/repos/run-1", env: undefined },
      { command: ["git", "checkout", "-B", "b-moe/ENG-123"], cwd: "/var/b-moe/repos/run-1", env: undefined },
    ]);
  });

  test("preserves Linear issue identifier casing in branch names", async () => {
    const service = new RepositoryService({
      env: loadEnv({ REDIS_HOST: "localhost", REPO_BASE_PATH: "/var/b-moe/repos" }),
      commandRunner: noopCommandRunner,
      fileSystem: noopFileSystem,
    });

    await expect(service.getWorkspace(createRun({ linearIssueId: "ENG-20", repoUrl: "https://github.com/acme/repo" })))
      .resolves.toMatchObject({ branchName: "b-moe/ENG-20" });
  });

  test("clones and pulls GitHub repositories with an app token remote", async () => {
    const commands: Array<{ command: readonly string[]; cwd?: string; env?: Record<string, string> }> = [];
    const service = new RepositoryService({
      env: loadEnv({ REDIS_HOST: "localhost", REPO_BASE_PATH: "/var/b-moe/repos" }),
      githubService: createGitHubService("installation-token-1"),
      commandRunner: {
        async run(command, options) {
          commands.push({ command, cwd: options?.cwd, env: options?.env });
        },
      },
      fileSystem: { async ensureDirectory() {}, async exists() { return false; } },
    });

    await service.getWorkspace(createRun({ linearIssueId: "ENG-123", repoUrl: "https://github.com/acme/repo", baseBranch: "main" }));

    const remote = "https://x-access-token:installation-token-1@github.com/acme/repo.git";
    expect(commands).toEqual([
      { command: ["git", "clone", remote, "/var/b-moe/repos/run-1"], cwd: undefined, env: undefined },
      { command: ["git", "checkout", "main"], cwd: "/var/b-moe/repos/run-1", env: undefined },
      { command: ["git", "pull", "--ff-only", remote, "main"], cwd: "/var/b-moe/repos/run-1", env: undefined },
      { command: ["git", "checkout", "-B", "b-moe/ENG-123"], cwd: "/var/b-moe/repos/run-1", env: undefined },
    ]);
  });

  test("fetches existing workspaces", async () => {
    const commands: Array<{ command: readonly string[]; cwd?: string; env?: Record<string, string> }> = [];
    const service = new RepositoryService({
      env: loadEnv({ REDIS_HOST: "localhost", REPO_BASE_PATH: "/var/b-moe/repos" }),
      commandRunner: {
        async run(command, options) {
          commands.push({ command, cwd: options?.cwd, env: options?.env });
        },
      },
      fileSystem: { async ensureDirectory() {}, async exists() { return true; } },
    });

    await service.getWorkspace(createRun({ repoUrl: "https://github.com/acme/repo" }));

    expect(commands).toEqual([
      { command: ["git", "fetch", "origin"], cwd: "/var/b-moe/repos/run-1", env: undefined },
      { command: ["git", "checkout", "-B", "b-moe/run-1"], cwd: "/var/b-moe/repos/run-1", env: undefined },
    ]);
  });

  test("requires a repository url", async () => {
    const service = new RepositoryService({
      env: loadEnv({ REDIS_HOST: "localhost" }),
      commandRunner: noopCommandRunner,
      fileSystem: noopFileSystem,
    });

    await expect(service.getWorkspace(createRun())).rejects.toThrow("has no repository URL");
  });
});

const noopCommandRunner: CommandRunner = { async run() {} };
const noopFileSystem: FileSystemClient = {
  async ensureDirectory() {},
  async exists() { return false; },
};

function createGitHubService(token: string) {
  return {
    async getAccessToken() { return token; },
    async createPullRequest() { throw new Error("unused"); },
  };
}
