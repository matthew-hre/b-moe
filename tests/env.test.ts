import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/config/env";

describe("loadEnv", () => {
  test("loads Linear OAuth client configuration when set", () => {
    const env = loadEnv({
      LINEAR_CLIENT_ID: "client-id-1",
      LINEAR_CLIENT_SECRET: "client-secret-1",
      REDIS_HOST: "localhost",
    });

    expect(env.linearClientId).toBe("client-id-1");
    expect(env.linearClientSecret).toBe("client-secret-1");
  });

  test("applies defaults", () => {
    const env = loadEnv({ REDIS_HOST: "localhost" });

    expect(env.dockerHost).toBe("local");
    expect(env.openrouterModel).toBe("google/gemini-3.1-flash-lite");
    expect(env.redisPort).toBe(6379);
  });

  test("coerces Redis port", () => {
    const env = loadEnv({ REDIS_HOST: "localhost", REDIS_PORT: "6380" });

    expect(env.redisPort).toBe(6380);
  });

  test("loads Pi RPC configuration", () => {
    const env = loadEnv({
      REDIS_HOST: "localhost",
      PI_COMMAND: "pi-dev",
      PI_PROVIDER: "anthropic",
      PI_MODEL: "claude-sonnet-4-20250514",
      PI_API_KEY: "pi-key-1",
      PI_THINKING_LEVEL: "medium",
      PI_TOOLS: "read,bash,edit",
    });

    expect(env.piCommand).toBe("pi-dev");
    expect(env.piProvider).toBe("anthropic");
    expect(env.piModel).toBe("claude-sonnet-4-20250514");
    expect(env.piApiKey).toBe("pi-key-1");
    expect(env.piThinkingLevel).toBe("medium");
    expect(env.piTools).toBe("read,bash,edit");
  });

  test("loads GitHub App configuration", () => {
    const env = loadEnv({
      REDIS_HOST: "localhost",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_CLIENT_ID: "client-id-1",
      GITHUB_APP_CLIENT_SECRET: "client-secret-1",
      GITHUB_APP_INSTALLATION_ID: "67890",
      GITHUB_APP_PRIVATE_KEY: "line-1\\nline-2",
    });

    expect(env.githubAppId).toBe("12345");
    expect(env.githubAppClientId).toBe("client-id-1");
    expect(env.githubAppClientSecret).toBe("client-secret-1");
    expect(env.githubAppInstallationId).toBe("67890");
    expect(env.githubAppPrivateKey).toBe("line-1\nline-2");
  });

  test("parses repository aliases", () => {
    const env = loadEnv({
      REDIS_HOST: "localhost",
      REPOSITORIES_JSON: JSON.stringify({
        frontend: "https://github.com/acme/web",
        backend: { url: "https://github.com/acme/api", baseBranch: "main" },
      }),
    });

    expect(env.repositories).toEqual({
      frontend: "https://github.com/acme/web",
      backend: { url: "https://github.com/acme/api", baseBranch: "main" },
    });
  });

  test("allows startup before the Linear app is configured", () => {
    const env = loadEnv({ REDIS_HOST: "localhost" });

    expect(env.linearClientId).toBeUndefined();
    expect(env.linearWebhookSecret).toBeUndefined();
  });

  test("requires Redis host", () => {
    expect(() => loadEnv({})).toThrow();
  });
});
