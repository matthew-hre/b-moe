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
  };
}

function createGitHubService(token: string) {
  return {
    async getAccessToken() { return token; },
    async createPullRequest() { throw new Error("unused"); },
  };
}
