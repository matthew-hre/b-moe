import { describe, expect, test } from "bun:test";
import { GitService, type CommandRunnerWithOutput } from "../src/services/git.service";

describe("GitService", () => {
  test("detects git changes from porcelain status", async () => {
    const service = new GitService({ commandRunner: createCommandRunner({ output: " M src/index.ts\n" }) });

    await expect(service.hasChanges("/repo/run-1")).resolves.toBe(true);
  });

  test("detects clean git status", async () => {
    const service = new GitService({ commandRunner: createCommandRunner({ outputs: ["", "commit-1\n", "commit-1\n"] }) });

    await expect(service.hasChanges("/repo/run-1")).resolves.toBe(false);
  });

  test("detects commits ahead of upstream", async () => {
    const service = new GitService({ commandRunner: createCommandRunner({ outputs: ["", "commit-2\n", "commit-1\n"] }) });

    await expect(service.hasChanges("/repo/run-1")).resolves.toBe(true);
  });

  test("detects commits ahead of base branch when no upstream exists", async () => {
    const service = new GitService({ commandRunner: createCommandRunner({ outputs: ["", "commit-2\n", "", "commit-1\n"] }) });

    await expect(service.hasChanges({ workingDirectory: "/repo/run-1", baseBranch: "main" })).resolves.toBe(true);
  });

  test("pushes branches with force-with-lease", async () => {
    const commands: Array<{ command: readonly string[]; cwd?: string; env?: Record<string, string> }> = [];
    const service = new GitService({ commandRunner: createCommandRunner({ commands }) });

    await service.pushBranch({ workingDirectory: "/repo/run-1", branchName: "b-moe/eng-123" });

    expect(commands).toEqual([
      {
        command: ["git", "push", "--set-upstream", "origin", "HEAD:refs/heads/b-moe/eng-123", "--force"],
        cwd: "/repo/run-1",
        env: undefined,
      },
    ]);
  });

  test("commits dirty working trees", async () => {
    const commands: Array<{ command: readonly string[]; cwd?: string; env?: Record<string, string> }> = [];
    const service = new GitService({ commandRunner: createCommandRunner({ output: "?? README.md\n", commands }) });

    await service.commitAll({ workingDirectory: "/repo/run-1", message: "MAT-7: B-MOE changes" });

    expect(commands).toEqual([
      { command: ["git", "status", "--porcelain"], cwd: "/repo/run-1", env: undefined },
      { command: ["git", "add", "--all"], cwd: "/repo/run-1", env: undefined },
      { command: ["git", "commit", "-m", "MAT-7: B-MOE changes"], cwd: "/repo/run-1", env: undefined },
    ]);
  });

  test("pushes GitHub branches with an app token remote", async () => {
    const commands: Array<{ command: readonly string[]; cwd?: string; env?: Record<string, string> }> = [];
    const service = new GitService({
      githubService: createGitHubService("installation-token-1"),
      commandRunner: createCommandRunner({ commands }),
    });

    await service.pushBranch({
      workingDirectory: "/repo/run-1",
      branchName: "b-moe/eng-123",
      repoUrl: "https://github.com/acme/repo",
    });

    expect(commands[0]).toEqual({
      command: ["git", "push", "--set-upstream", "https://x-access-token:installation-token-1@github.com/acme/repo.git", "HEAD:refs/heads/b-moe/eng-123", "--force"],
      cwd: "/repo/run-1",
      env: undefined,
    });
  });
});

function createCommandRunner({
  output = "",
  outputs,
  commands = [],
}: {
  output?: string;
  outputs?: string[];
  commands?: Array<{ command: readonly string[]; cwd?: string; env?: Record<string, string> }>;
} = {}): CommandRunnerWithOutput {
  return {
    async run(command, options) {
      commands.push({ command, cwd: options?.cwd, env: options?.env });
    },
    async runForOutput(command, options) {
      commands.push({ command, cwd: options?.cwd, env: options?.env });
      return outputs?.shift() ?? output;
    },
  };
}

function createGitHubService(token: string) {
  return {
    async getAccessToken() { return token; },
    async createPullRequest() { throw new Error("unused"); },
  };
}
