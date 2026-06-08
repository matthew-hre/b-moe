import type { Env } from "../config/env";
import { createAuthenticatedGitHubUrl } from "./repository.service";
import type { GitHubClient } from "./github.service";
import { resolveSandboxGitIdentity, type SandboxClient, type SandboxSession } from "./sandbox.service";

export interface ChangedFile {
  readonly status: string;
  readonly path: string;
}

export interface GitClient {
  hasChanges(input: { sandbox: SandboxSession; baseBranch?: string }): Promise<boolean>;
  describeHead(input: { sandbox: SandboxSession; baseBranch?: string }): Promise<string>;
  commitAll(input: { sandbox: SandboxSession; message: string }): Promise<void>;
  commitFiles(input: { sandbox: SandboxSession; message: string; files: readonly string[] }): Promise<void>;
  getChangedFiles(input: { sandbox: SandboxSession }): Promise<readonly ChangedFile[]>;
  pushBranch(input: { sandbox: SandboxSession; branchName: string; repoUrl?: string }): Promise<void>;
}

export interface GitServiceDependencies {
  readonly env: Env;
  readonly sandboxService: SandboxClient;
  readonly githubService?: GitHubClient;
}

export class GitService implements GitClient {
  private readonly env: Env;
  private readonly sandboxService: SandboxClient;
  private readonly githubService?: GitHubClient;

  constructor({ env, sandboxService, githubService }: GitServiceDependencies) {
    this.env = env;
    this.sandboxService = sandboxService;
    this.githubService = githubService;
  }

  async hasChanges({ sandbox, baseBranch }: { sandbox: SandboxSession; baseBranch?: string }): Promise<boolean> {
    const status = await this.runForOutput(sandbox, ["git", "status", "--porcelain"]);

    if (status.trim().length > 0) {
      return true;
    }

    const head = await this.runForOutput(sandbox, ["git", "rev-parse", "HEAD"]);
    const upstream = await this.runForOutput(sandbox, ["git", "rev-parse", "@{upstream}"]).catch(() => "");

    if (upstream.trim()) {
      return head.trim() !== upstream.trim();
    }

    const base = await this.runForOutput(sandbox, ["git", "rev-parse", baseBranch ?? "main"]).catch(() => "");

    return Boolean(base.trim()) && head.trim() !== base.trim();
  }

  async pushBranch({ sandbox, branchName, repoUrl }: { sandbox: SandboxSession; branchName: string; repoUrl?: string }): Promise<void> {
    const remote = await this.createRemote(repoUrl);

    await this.run(sandbox, ["git", "push", "--set-upstream", remote, `HEAD:refs/heads/${branchName}`, "--force"]);
  }

  async commitFiles({ sandbox, message, files }: { sandbox: SandboxSession; message: string; files: readonly string[] }): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.ensureGitIdentity(sandbox);
    await this.run(sandbox, ["git", "add", ...files]);
    await this.run(sandbox, ["git", "commit", "-m", message]);
  }

  async getChangedFiles({ sandbox }: { sandbox: SandboxSession }): Promise<readonly ChangedFile[]> {
    const output = await this.runForOutput(sandbox, ["git", "diff", "--name-status", "HEAD"]);

    if (!output.trim()) {
      return [];
    }

    return output
      .trim()
      .split("\n")
      .map((line) => {
        const [status, ...pathParts] = line.split("\t");
        return { status: status ?? "?", path: pathParts.join("\t") };
      })
      .filter((entry) => entry.path.length > 0);
  }

  async commitAll({ sandbox, message }: { sandbox: SandboxSession; message: string }): Promise<void> {
    const status = await this.runForOutput(sandbox, ["git", "status", "--porcelain"]);

    if (!status.trim()) {
      return;
    }

    await this.ensureGitIdentity(sandbox);
    await this.run(sandbox, ["git", "add", "--all"]);
    await this.run(sandbox, ["git", "commit", "-m", message]);
  }

  async describeHead({ sandbox, baseBranch = "main" }: { sandbox: SandboxSession; baseBranch?: string }): Promise<string> {
    const branch = await this.runForOutput(sandbox, ["git", "branch", "--show-current"]).catch((error) => `branch error: ${error instanceof Error ? error.message : String(error)}`);
    const status = await this.runForOutput(sandbox, ["git", "status", "--porcelain"]).catch((error) => `status error: ${error instanceof Error ? error.message : String(error)}`);
    const log = await this.runForOutput(sandbox, ["git", "log", "--oneline", "--decorate", "-5"]).catch((error) => `log error: ${error instanceof Error ? error.message : String(error)}`);
    const diff = await this.runForOutput(sandbox, ["git", "log", "--oneline", `${baseBranch}..HEAD`]).catch((error) => `diff error: ${error instanceof Error ? error.message : String(error)}`);

    return [`branch=${branch.trim()}`, `status=${status.trim() || "clean"}`, `${baseBranch}..HEAD=${diff.trim() || "empty"}`, `recent=${log.trim()}`].join(" | ");
  }

  private async run(sandbox: SandboxSession, command: readonly string[]): Promise<void> {
    const result = await this.sandboxService.exec(sandbox, command);

    if (result.exitCode !== 0) {
      throw new Error(`Command failed (${command.join(" ")}): ${result.stderr || result.stdout}`);
    }
  }

  private async runForOutput(sandbox: SandboxSession, command: readonly string[]): Promise<string> {
    const result = await this.sandboxService.exec(sandbox, command);

    if (result.exitCode !== 0) {
      throw new Error(`Command failed (${command.join(" ")}): ${result.stderr || result.stdout}`);
    }

    return result.stdout;
  }

  private async ensureGitIdentity(sandbox: SandboxSession): Promise<void> {
    const { name, email } = resolveSandboxGitIdentity(this.env);

    await this.run(sandbox, ["git", "config", "user.name", name]);
    await this.run(sandbox, ["git", "config", "user.email", email]);
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
