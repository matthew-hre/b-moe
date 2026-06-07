import { mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { Run } from "../models/run";
import type { Env } from "../config/env";
import type { GitHubClient } from "./github.service";

export interface RepositoryInfo {
  readonly url: string;
  readonly baseBranch?: string;
}

export type RepositoryResolution =
  | Readonly<{ kind: "resolved"; repository: RepositoryInfo }>
  | Readonly<{ kind: "needs_input"; question: string }>;

export interface RepositoryWorkspace {
  readonly repoUrl: string;
  readonly baseBranch?: string;
  readonly branchName: string;
  readonly path: string;
}

export interface RepositoryClient {
  getWorkspace(run: Run): Promise<RepositoryWorkspace>;
  resolve(promptContext: string | undefined): RepositoryResolution;
}

export interface CommandRunner {
  run(command: readonly string[], options?: CommandRunnerOptions): Promise<void>;
}

export interface CommandRunnerOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

interface GitAuthOptions {
  readonly env?: Record<string, string>;
  readonly remoteUrl?: string;
}

export interface FileSystemClient {
  ensureDirectory(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface RepositoryServiceDependencies {
  readonly env: Env;
  readonly githubService?: GitHubClient;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: FileSystemClient;
}

export class BunCommandRunner implements CommandRunner {
  async run(command: readonly string[], options: CommandRunnerOptions = {}): Promise<void> {
    console.log(`[command-runner] running ${sanitizeCommand(command).join(" ")} cwd=${options.cwd ?? process.cwd()}`);
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
  }
}

export function getProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export class NodeFileSystemClient implements FileSystemClient {
  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }
}

export class RepositoryService implements RepositoryClient {
  private readonly repoBasePath: string;
  private readonly repositories: Record<string, RepositoryInfo>;
  private readonly githubService?: GitHubClient;
  private readonly commandRunner: CommandRunner;
  private readonly fileSystem: FileSystemClient;

  constructor({
    env,
    githubService,
    commandRunner = new BunCommandRunner(),
    fileSystem = new NodeFileSystemClient(),
  }: RepositoryServiceDependencies) {
    this.repoBasePath = env.repoBasePath ?? "/tmp/b-moe/repos";
    this.repositories = normalizeRepositories(env.repositories);
    this.githubService = githubService;
    this.commandRunner = commandRunner;
    this.fileSystem = fileSystem;
  }

  async getWorkspace(run: Run): Promise<RepositoryWorkspace> {
    if (!run.repoUrl) {
      throw new Error(`Run ${run.id} has no repository URL`);
    }

    console.log(`[repository-service] get workspace runId=${run.id} repoUrl=${run.repoUrl}`);

    const workspace = {
      repoUrl: run.repoUrl,
      baseBranch: run.baseBranch,
      branchName: createBranchName(run),
      path: `${this.repoBasePath}/${run.id}`,
    };

    await this.prepareWorkspace(workspace);

    return workspace;
  }

  resolve(promptContext: string | undefined): RepositoryResolution {
    const explicitRepository = extractRepositoryInfo(promptContext);

    if (explicitRepository) {
      return { kind: "resolved", repository: explicitRepository };
    }

    const alias = extractRepositoryAlias(promptContext);

    if (alias && this.repositories[alias]) {
      return { kind: "resolved", repository: this.repositories[alias] };
    }

    const aliases = Object.keys(this.repositories);

    if (aliases.length > 0) {
      return {
        kind: "needs_input",
        question: `Which repository should I use? Options: ${aliases.join(", ")}.`,
      };
    }

    return {
      kind: "needs_input",
      question: "Which repository should I use? Please reply with a GitHub URL or repository alias.",
    };
  }

  private async prepareWorkspace(workspace: RepositoryWorkspace): Promise<void> {
    console.log(`[repository-service] prepare workspace path=${workspace.path} branch=${workspace.branchName}`);
    await this.fileSystem.ensureDirectory(this.repoBasePath);
    const authOptions = await this.createGitAuthOptions(workspace.repoUrl);
    console.log(`[repository-service] git auth configured=${Boolean(authOptions.remoteUrl)} repoUrl=${workspace.repoUrl}`);

    if (await this.fileSystem.exists(`${workspace.path}/.git`)) {
      console.log(`[repository-service] existing workspace found path=${workspace.path}`);
      await this.commandRunner.run(["git", "fetch", authOptions.remoteUrl ?? "origin"], { env: authOptions.env, cwd: workspace.path });
    } else {
      console.log(`[repository-service] cloning workspace path=${workspace.path}`);
      await this.commandRunner.run(["git", "clone", authOptions.remoteUrl ?? workspace.repoUrl, workspace.path], { env: authOptions.env });
    }

    if (workspace.baseBranch) {
      await this.commandRunner.run(["git", "checkout", workspace.baseBranch], { cwd: workspace.path });
      await this.commandRunner.run(["git", "pull", "--ff-only", authOptions.remoteUrl ?? "origin", workspace.baseBranch], {
        env: authOptions.env,
        cwd: workspace.path,
      });
    }

    await this.commandRunner.run(["git", "checkout", "-B", workspace.branchName], { cwd: workspace.path });
  }

  private async createGitAuthOptions(repoUrl: string): Promise<GitAuthOptions> {
    if (!this.githubService || !isGitHubUrl(repoUrl)) {
      return {};
    }

    console.log(`[repository-service] fetching GitHub installation token for git auth`);
    const token = await this.githubService.getAccessToken();
    console.log(`[repository-service] fetched GitHub installation token for git auth`);

    return { remoteUrl: createAuthenticatedGitHubUrl(repoUrl, token) };
  }
}

export function extractRepositoryInfo(promptContext: string | undefined): RepositoryInfo | undefined {
  if (!promptContext) {
    return undefined;
  }

  const url =
    extractTag(promptContext, "repoUrl") ??
    extractTag(promptContext, "repositoryUrl") ??
    promptContext.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?/)?.[0];

  if (!url) {
    return undefined;
  }

  return {
    url,
    baseBranch: extractTag(promptContext, "baseBranch") ?? extractTag(promptContext, "branch"),
  };
}

function extractTag(value: string, tagName: string): string | undefined {
  const match = value.match(new RegExp(`<${tagName}>(?<value>.*?)</${tagName}>`, "s"));

  return match?.groups?.value.trim() || undefined;
}

function extractRepositoryAlias(promptContext: string | undefined): string | undefined {
  if (!promptContext) {
    return undefined;
  }

  return (
    extractTag(promptContext, "repo") ??
    extractTag(promptContext, "repository") ??
    promptContext.match(/\b(?:repo|repository):\s*(?<alias>[\w.-]+)/i)?.groups?.alias
  )?.toLowerCase();
}

function normalizeRepositories(
  repositories: Record<string, string | { url: string; baseBranch?: string }>,
): Record<string, RepositoryInfo> {
  return Object.fromEntries(
    Object.entries(repositories).map(([alias, value]) => [
      alias.toLowerCase(),
      typeof value === "string" ? { url: value } : value,
    ]),
  );
}

function createBranchName(run: Run): string {
  return `b-moe/${sanitizeBranchSegment(run.linearIssueId ?? run.id)}`;
}

function sanitizeBranchSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function isGitHubUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

export function createAuthenticatedGitHubUrl(repoUrl: string, token: string): string {
  const url = new URL(repoUrl.endsWith(".git") ? repoUrl : `${repoUrl}.git`);
  url.username = "x-access-token";
  url.password = token;

  return url.toString();
}

function sanitizeCommand(command: readonly string[]): readonly string[] {
  return command.map((part) => part.replace(/https:\/\/x-access-token:[^@]+@github\.com/g, "https://x-access-token:***@github.com"));
}
