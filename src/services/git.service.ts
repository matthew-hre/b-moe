import { spawnSync } from "node:child_process";
import { BunCommandRunner, createAuthenticatedGitHubUrl, getProcessEnv, type CommandRunner, type CommandRunnerOptions } from "./repository.service";
import type { GitHubClient } from "./github.service";

export interface GitClient {
  hasChanges(workingDirectory: string): Promise<boolean>;
  hasChanges(input: { workingDirectory: string; baseBranch?: string }): Promise<boolean>;
  describeHead(input: { workingDirectory: string; baseBranch?: string }): Promise<string>;
  commitAll(input: { workingDirectory: string; message: string }): Promise<void>;
  pushBranch(input: { workingDirectory: string; branchName: string; repoUrl?: string }): Promise<void>;
}

export interface GitServiceDependencies {
  readonly githubService?: GitHubClient;
  readonly commandRunner?: CommandRunnerWithOutput;
}

export interface CommandRunnerWithOutput extends CommandRunner {
  runForOutput(command: readonly string[], options?: CommandRunnerOptions): Promise<string>;
}

export class BunGitCommandRunner extends BunCommandRunner implements CommandRunnerWithOutput {
  async runForOutput(command: readonly string[], options: CommandRunnerOptions = {}): Promise<string> {
    console.log(`[command-runner] running ${command.join(" ")} cwd=${options.cwd ?? process.cwd()}`);
    const [program, ...args] = command;
    const result = spawnSync(program, args, {
      cwd: options.cwd,
      env: options.env ? { ...getProcessEnv(), ...options.env } : getProcessEnv(),
      encoding: "utf8",
    });

    if (result.error || result.status !== 0) {
      throw new Error(
        `Command failed (${command.join(" ")}): ${result.error?.message ?? (result.stderr || result.stdout)}`,
      );
    }

    return result.stdout;
  }
}

export class GitService implements GitClient {
  private readonly githubService?: GitHubClient;
  private readonly commandRunner: CommandRunnerWithOutput;

  constructor({ githubService, commandRunner = new BunGitCommandRunner() }: GitServiceDependencies = {}) {
    this.githubService = githubService;
    this.commandRunner = commandRunner;
  }

  async hasChanges(input: string | { workingDirectory: string; baseBranch?: string }): Promise<boolean> {
    const workingDirectory = typeof input === "string" ? input : input.workingDirectory;
    const baseBranch = typeof input === "string" ? undefined : input.baseBranch;
    const status = await this.commandRunner.runForOutput(["git", "status", "--porcelain"], {
      cwd: workingDirectory,
    });

    if (status.trim().length > 0) {
      return true;
    }

    const head = await this.commandRunner.runForOutput(["git", "rev-parse", "HEAD"], { cwd: workingDirectory });
    const upstream = await this.commandRunner.runForOutput(["git", "rev-parse", "@{upstream}"], { cwd: workingDirectory }).catch(() => "");

    if (upstream.trim()) {
      return head.trim() !== upstream.trim();
    }

    const base = await this.commandRunner.runForOutput(["git", "rev-parse", baseBranch ?? "main"], { cwd: workingDirectory }).catch(() => "");

    return Boolean(base.trim()) && head.trim() !== base.trim();
  }

  async pushBranch({ workingDirectory, branchName, repoUrl }: { workingDirectory: string; branchName: string; repoUrl?: string }): Promise<void> {
    const remote = await this.createRemote(repoUrl);

    await this.commandRunner.run(["git", "push", "--set-upstream", remote, `HEAD:refs/heads/${branchName}`, "--force"], {
      cwd: workingDirectory,
    });
  }

  async commitAll({ workingDirectory, message }: { workingDirectory: string; message: string }): Promise<void> {
    const status = await this.commandRunner.runForOutput(["git", "status", "--porcelain"], { cwd: workingDirectory });

    if (!status.trim()) {
      return;
    }

    await this.commandRunner.run(["git", "add", "--all"], { cwd: workingDirectory });
    await this.commandRunner.run(["git", "commit", "-m", message], { cwd: workingDirectory });
  }

  async describeHead({ workingDirectory, baseBranch = "main" }: { workingDirectory: string; baseBranch?: string }): Promise<string> {
    const branch = await this.commandRunner.runForOutput(["git", "branch", "--show-current"], { cwd: workingDirectory }).catch((error) => `branch error: ${error instanceof Error ? error.message : String(error)}`);
    const status = await this.commandRunner.runForOutput(["git", "status", "--porcelain"], { cwd: workingDirectory }).catch((error) => `status error: ${error instanceof Error ? error.message : String(error)}`);
    const log = await this.commandRunner.runForOutput(["git", "log", "--oneline", "--decorate", "-5"], { cwd: workingDirectory }).catch((error) => `log error: ${error instanceof Error ? error.message : String(error)}`);
    const diff = await this.commandRunner.runForOutput(["git", "log", "--oneline", `${baseBranch}..HEAD`], { cwd: workingDirectory }).catch((error) => `diff error: ${error instanceof Error ? error.message : String(error)}`);

    return [`branch=${branch.trim()}`, `status=${status.trim() || "clean"}`, `${baseBranch}..HEAD=${diff.trim() || "empty"}`, `recent=${log.trim()}`].join(" | ");
  }

  private async createRemote(repoUrl: string | undefined): Promise<string> {
    if (!this.githubService || !repoUrl || !isGitHubUrl(repoUrl)) {
      return "origin";
    }

    const token = await this.githubService.getAccessToken();

    return createAuthenticatedGitHubUrl(repoUrl, token);
  }
}

function isGitHubUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}
