import { createSign } from "node:crypto";
import { createLogger } from "../logger";
import type { Env } from "../config/env";
import type { Run } from "../models/run";

const logger = createLogger("github-service");

export interface CreatePullRequestInput {
  readonly run: Run;
  readonly repoUrl: string;
  readonly branchName: string;
  readonly baseBranch?: string;
  readonly summary: string;
  readonly title?: string;
}

export interface CreatedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly branchName: string;
}

export interface GitHubClient {
  createPullRequest(input: CreatePullRequestInput): Promise<CreatedPullRequest>;
  getAccessToken(): Promise<string>;
}

export interface GitHubServiceDependencies {
  readonly env: Env;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly signJwtFn?: (payload: GitHubAppJwtPayload, privateKey: string) => Promise<string>;
}

interface GitHubAppJwtPayload {
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
}

export class MissingGitHubConfigError extends Error {
  constructor() {
    super("GitHub App credentials or GITHUB_TOKEN are required to create pull requests");
    this.name = "MissingGitHubConfigError";
  }
}

export class GitHubService implements GitHubClient {
  private readonly env: Env;
  private readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly signJwt: (payload: GitHubAppJwtPayload, privateKey: string) => Promise<string>;

  constructor({ env, fetch = globalThis.fetch, now = () => Date.now(), signJwtFn = signJwt }: GitHubServiceDependencies) {
    this.env = env;
    this.fetch = fetch;
    this.now = now;
    this.signJwt = signJwtFn;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<CreatedPullRequest> {
    const token = await this.getAccessToken();

    const repository = parseGitHubRepository(input.repoUrl);
    const response = await this.fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: input.title ?? (input.run.linearIssueId ? `${input.run.linearIssueId}: B-MOE implementation` : "B-MOE implementation"),
        head: input.branchName,
        base: input.baseBranch ?? "main",
        body: input.summary,
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub pull request creation failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as { number: number; html_url: string };

    return { number: body.number, url: body.html_url, branchName: input.branchName };
  }

  async getAccessToken(): Promise<string> {
    if (this.hasGitHubAppConfig()) {
      logger.info(`creating GitHub App installation token installationId=${this.env.githubAppInstallationId}`);
      const jwt = await this.createAppJwt();
      const response = await this.fetch(
        `https://api.github.com/app/installations/${this.env.githubAppInstallationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      if (!response.ok) {
        throw new Error(`GitHub App token exchange failed: ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as { token: string };

      logger.info(`created GitHub App installation token installationId=${this.env.githubAppInstallationId}`);

      return body.token;
    }

    if (this.env.githubToken) {
      return this.env.githubToken;
    }

    throw new MissingGitHubConfigError();
  }

  private hasGitHubAppConfig(): boolean {
    return Boolean(this.env.githubAppId && this.env.githubAppInstallationId && this.env.githubAppPrivateKey);
  }

  private async createAppJwt(): Promise<string> {
    if (!this.env.githubAppId || !this.env.githubAppPrivateKey) {
      throw new MissingGitHubConfigError();
    }

    const issuedAt = Math.floor(this.now() / 1000) - 60;
    const expiresAt = issuedAt + 540;
    return this.signJwt({ iat: issuedAt, exp: expiresAt, iss: this.env.githubAppId }, this.env.githubAppPrivateKey);
  }
}

async function signJwt(payload: GitHubAppJwtPayload, privateKey: string): Promise<string> {
    const encodedHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(privateKey);

    return `${signingInput}.${base64UrlEncode(signature)}`;
}

function parseGitHubRepository(repoUrl: string): { owner: string; repo: string } {
  const url = new URL(repoUrl.endsWith(".git") ? repoUrl.slice(0, -4) : repoUrl);
  const [owner, repo] = url.pathname.replace(/^\//, "").split("/");

  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
  }

  return { owner, repo };
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}
