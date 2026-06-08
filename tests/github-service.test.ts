import { describe, expect, test } from "bun:test";
import { GitHubService, MissingGitHubConfigError } from "../src/services/github.service";
import { loadEnv } from "../src/config/env";
import type { Run } from "../src/models/run";

const now = new Date("2025-01-01T00:00:00.000Z");
const run: Run = {
  id: "run-1",
  agentSessionId: "session-1",
  linearIssueId: "ENG-123",
  state: "acting",
  createdAt: now,
  updatedAt: now,
};

describe("GitHubService", () => {
  test("creates pull requests with a token fallback", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const service = new GitHubService({
      env: loadEnv({ REDIS_HOST: "localhost", GITHUB_TOKEN: "github-token-1" }),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({ number: 7, html_url: "https://github.com/acme/repo/pull/7" });
      },
    });

    await expect(service.createPullRequest({
      run,
      repoUrl: "https://github.com/acme/repo.git",
      branchName: "b-moe/eng-123",
      baseBranch: "develop",
      summary: "Done",
    })).resolves.toEqual({
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      branchName: "b-moe/eng-123",
    });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/repo/pulls");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      title: "ENG-123: B-MOE implementation",
      head: "b-moe/eng-123",
      base: "develop",
    });
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer github-token-1" });
  });

  test("creates pull requests with a GitHub App installation token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const service = new GitHubService({
      env: loadEnv({
        REDIS_HOST: "localhost",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_INSTALLATION_ID: "67890",
        GITHUB_APP_PRIVATE_KEY: "private-key-1",
      }),
      now: () => Date.parse("2025-01-01T00:00:00.000Z"),
      signJwtFn: async (payload, privateKey) => {
        expect(payload).toEqual({ iat: 1_735_689_540, exp: 1_735_690_080, iss: "12345" });
        expect(privateKey).toBe("private-key-1");

        return "app-jwt-1";
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });

        if (String(url).endsWith("/access_tokens")) {
          return Response.json({ token: "installation-token-1" });
        }

        return Response.json({ number: 8, html_url: "https://github.com/acme/repo/pull/8" });
      },
    });

    await expect(service.createPullRequest({
      run,
      repoUrl: "https://github.com/acme/repo",
      branchName: "b-moe/eng-123",
      summary: "Done",
    })).resolves.toEqual({
      number: 8,
      url: "https://github.com/acme/repo/pull/8",
      branchName: "b-moe/eng-123",
    });
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer app-jwt-1",
      Accept: "application/vnd.github+json",
    });
    expect(calls[1]?.url).toBe("https://api.github.com/repos/acme/repo/pulls");
    expect(calls[1]?.init.headers).toMatchObject({ Authorization: "Bearer installation-token-1" });
  });

  test("requires GitHub credentials", async () => {
    const service = new GitHubService({ env: loadEnv({ REDIS_HOST: "localhost" }) });

    await expect(service.createPullRequest({
      run,
      repoUrl: "https://github.com/acme/repo",
      branchName: "b-moe/eng-123",
      summary: "Done",
    })).rejects.toThrow(MissingGitHubConfigError);
  });
});
