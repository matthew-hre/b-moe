import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/config/env";
import { GitService } from "../src/services/git.service";
import type { SandboxClient, SandboxSession } from "../src/services/sandbox.service";

const env = loadEnv({ REDIS_HOST: "localhost", BOT_GITHUB_USERNAME: "b-moe-bot" });

const sandbox: SandboxSession = {
  id: "sandbox-run-1",
  runId: "run-1",
  containerId: "container-1",
  workingDirectory: "/workspace",
  branchName: "b-moe/eng-123",
};

describe("GitService", () => {
  test("detects git changes from porcelain status", async () => {
    const service = new GitService({ env, sandboxService: createSandboxService({ output: " M src/index.ts\n" }) });

    await expect(service.hasChanges({ sandbox })).resolves.toBe(true);
  });

  test("detects clean git status", async () => {
    const service = new GitService({
      env,
      sandboxService: createSandboxService({ outputs: ["", "commit-1\n", "commit-1\n"] }),
    });

    await expect(service.hasChanges({ sandbox })).resolves.toBe(false);
  });

  test("detects commits ahead of upstream", async () => {
    const service = new GitService({
      env,
      sandboxService: createSandboxService({ outputs: ["", "commit-2\n", "commit-1\n"] }),
    });

    await expect(service.hasChanges({ sandbox })).resolves.toBe(true);
  });

  test("detects commits ahead of base branch when no upstream exists", async () => {
    const service = new GitService({
      env,
      sandboxService: createSandboxService({ outputs: ["", "commit-2\n", "", "commit-1\n"] }),
    });

    await expect(service.hasChanges({ sandbox, baseBranch: "main" })).resolves.toBe(true);
  });

  test("pushes branches with force", async () => {
    const commands: Array<readonly string[]> = [];
    const service = new GitService({ env, sandboxService: createSandboxService({ commands }) });

    await service.pushBranch({ sandbox, branchName: "b-moe/eng-123" });

    expect(commands).toEqual([
      ["git", "push", "--set-upstream", "origin", "HEAD:refs/heads/b-moe/eng-123", "--force"],
    ]);
  });

  test("commits dirty working trees", async () => {
    const commands: Array<readonly string[]> = [];
    const service = new GitService({
      env,
      sandboxService: createSandboxService({ output: "?? README.md\n", commands }),
    });

    await service.commitAll({ sandbox, message: "MAT-7: B-MOE changes" });

    expect(commands).toEqual([
      ["git", "status", "--porcelain"],
      ["git", "config", "user.name", "b-moe-bot"],
      ["git", "config", "user.email", "b-moe-bot@users.noreply.github.com"],
      ["git", "add", "--all"],
      ["git", "commit", "-m", "MAT-7: B-MOE changes"],
    ]);
  });

  test("pushes GitHub branches with an app token remote", async () => {
    const commands: Array<readonly string[]> = [];
    const service = new GitService({
      env,
      githubService: createGitHubService("installation-token-1"),
      sandboxService: createSandboxService({ commands }),
    });

    await service.pushBranch({
      sandbox,
      branchName: "b-moe/eng-123",
      repoUrl: "https://github.com/acme/repo",
    });

    expect(commands[0]).toEqual([
      "git",
      "push",
      "--set-upstream",
      "https://x-access-token:installation-token-1@github.com/acme/repo.git",
      "HEAD:refs/heads/b-moe/eng-123",
      "--force",
    ]);
  });

  test("getChangedFiles parses git diff --name-status output", async () => {
    const service = new GitService({
      env,
      sandboxService: createSandboxService({
        output: "M\tsrc/index.ts\nA\tsrc/new-feature.ts\nD\tsrc/old-file.ts\n",
      }),
    });

    const files = await service.getChangedFiles({ sandbox });

    expect(files).toEqual([
      { status: "M", path: "src/index.ts" },
      { status: "A", path: "src/new-feature.ts" },
      { status: "D", path: "src/old-file.ts" },
    ]);
  });

  test("getChangedFiles returns empty array for clean working tree", async () => {
    const service = new GitService({
      env,
      sandboxService: createSandboxService({ output: "" }),
    });

    const files = await service.getChangedFiles({ sandbox });

    expect(files).toEqual([]);
  });

  test("commitFiles stages and commits specific files", async () => {
    const commands: Array<readonly string[]> = [];
    const service = new GitService({
      env,
      sandboxService: createSandboxService({ commands }),
    });

    await service.commitFiles({
      sandbox,
      message: "feat: add new feature",
      files: ["src/feature.ts", "tests/feature.test.ts"],
    });

    expect(commands).toEqual([
      ["git", "config", "user.name", "b-moe-bot"],
      ["git", "config", "user.email", "b-moe-bot@users.noreply.github.com"],
      ["git", "add", "src/feature.ts", "tests/feature.test.ts"],
      ["git", "commit", "-m", "feat: add new feature"],
    ]);
  });

  test("commitFiles skips commit when no files provided", async () => {
    const commands: Array<readonly string[]> = [];
    const service = new GitService({
      env,
      sandboxService: createSandboxService({ commands }),
    });

    await service.commitFiles({ sandbox, message: "empty commit", files: [] });

    expect(commands).toEqual([]);
  });
});

function createSandboxService({
  output = "",
  outputs,
  commands = [],
}: {
  output?: string;
  outputs?: string[];
  commands?: Array<readonly string[]>;
} = {}): SandboxClient {
  return {
    startProvisioning() {},
    async ensureSession() {
      return sandbox;
    },
    async exec(_session, command) {
      commands.push(command);
      return { stdout: outputs?.shift() ?? output, stderr: "", exitCode: 0 };
    },
    async execStream() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async destroySession() {},
    async destroyRunSandbox() {},
  };
}

function createGitHubService(token: string) {
  return {
    async getAccessToken() { return token; },
    async createPullRequest() { throw new Error("unused"); },
  };
}
