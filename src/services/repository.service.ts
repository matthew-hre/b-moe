import type { Run } from "../models/run";
import type { Env } from "../config/env";

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
  readonly path: string;
}

export interface RepositoryClient {
  getWorkspace(run: Run): Promise<RepositoryWorkspace>;
  resolve(promptContext: string | undefined): RepositoryResolution;
}

export interface RepositoryServiceDependencies {
  readonly env: Env;
}

export class RepositoryService implements RepositoryClient {
  private readonly repoBasePath: string;
  private readonly repositories: Record<string, RepositoryInfo>;

  constructor({ env }: RepositoryServiceDependencies) {
    this.repoBasePath = env.repoBasePath ?? "/tmp/b-moe/repos";
    this.repositories = normalizeRepositories(env.repositories);
  }

  async getWorkspace(run: Run): Promise<RepositoryWorkspace> {
    if (!run.repoUrl) {
      throw new Error(`Run ${run.id} has no repository URL`);
    }

    return {
      repoUrl: run.repoUrl,
      baseBranch: run.baseBranch,
      path: `${this.repoBasePath}/${run.id}`,
    };
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
