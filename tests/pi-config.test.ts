import { describe, expect, test } from "bun:test";
import {
  buildPiArgs,
  buildPiAuthJson,
  buildPiSettingsJson,
  injectPiAgentConfig,
  resolvePiAgentConfig,
} from "../src/services/pi-config";
import { loadEnv } from "../src/config/env";
import type { SandboxClient, SandboxSession } from "../src/services/sandbox.service";

const sandbox: SandboxSession = {
  id: "sandbox-run-1",
  runId: "run-1",
  containerId: "container-1",
  workingDirectory: "/workspace",
  branchName: "b-moe/eng-123",
};

describe("resolvePiAgentConfig", () => {
  test("falls back to OpenRouter credentials when PI_* is unset", () => {
    const config = resolvePiAgentConfig(loadEnv({
      REDIS_HOST: "localhost",
      OPENROUTER_API_KEY: "sk-or-v1-test",
      OPENROUTER_MODEL: "google/gemini-3.1-flash-lite",
      PI_THINKING_LEVEL: "medium",
    }));

    expect(config).toEqual({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      apiKey: "sk-or-v1-test",
      thinkingLevel: "medium",
    });
  });

  test("prefers explicit PI_* values over OpenRouter", () => {
    const config = resolvePiAgentConfig(loadEnv({
      REDIS_HOST: "localhost",
      OPENROUTER_API_KEY: "sk-or-v1-openrouter",
      OPENROUTER_MODEL: "google/gemini-3.1-flash-lite",
      PI_PROVIDER: "anthropic",
      PI_MODEL: "claude-sonnet-4-20250514",
      PI_API_KEY: "sk-ant-test",
    }));

    expect(config).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-test",
      thinkingLevel: undefined,
    });
  });

  test("returns undefined when no API key is configured", () => {
    expect(resolvePiAgentConfig(loadEnv({ REDIS_HOST: "localhost" }))).toBeUndefined();
  });
});

describe("Pi config files", () => {
  test("builds auth.json in Pi's expected shape", () => {
    expect(buildPiAuthJson({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      apiKey: "sk-or-v1-test",
    })).toBe(JSON.stringify({
      openrouter: { type: "api_key", key: "sk-or-v1-test" },
    }));
  });

  test("builds settings.json with provider, model, and thinking level", () => {
    expect(buildPiSettingsJson({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      apiKey: "sk-or-v1-test",
      thinkingLevel: "medium",
    })).toBe(JSON.stringify({
      defaultProvider: "openrouter",
      defaultModel: "google/gemini-3.1-flash-lite",
      defaultThinkingLevel: "medium",
    }));
  });

  test("builds CLI args from resolved config", () => {
    expect(buildPiArgs({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      apiKey: "sk-or-v1-test",
      thinkingLevel: "medium",
    }, loadEnv({ REDIS_HOST: "localhost", PI_TOOLS: "read,bash" }))).toEqual([
      "--mode",
      "json",
      "--offline",
      "--provider",
      "openrouter",
      "--model",
      "google/gemini-3.1-flash-lite",
      "--api-key",
      "sk-or-v1-test",
      "--thinking",
      "medium",
      "--tools",
      "read,bash",
    ]);
  });

  test("builds CLI args for a named persisted session with default tools", () => {
    expect(buildPiArgs({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      apiKey: "sk-or-v1-test",
    }, loadEnv({ REDIS_HOST: "localhost" }), { sessionName: "run-1" })).toEqual([
      "--mode",
      "json",
      "--offline",
      "--provider",
      "openrouter",
      "--model",
      "google/gemini-3.1-flash-lite",
      "--api-key",
      "sk-or-v1-test",
      "--name",
      "run-1",
      "--tools",
      "read,write,edit,bash,grep,find,ls",
    ]);
  });

  test("builds CLI args for resuming a saved Pi session", () => {
    expect(buildPiArgs({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      apiKey: "sk-or-v1-test",
    }, loadEnv({ REDIS_HOST: "localhost" }), { sessionId: "pi-session-1" })).toEqual([
      "--mode",
      "json",
      "--offline",
      "--provider",
      "openrouter",
      "--model",
      "google/gemini-3.1-flash-lite",
      "--api-key",
      "sk-or-v1-test",
      "--session",
      "pi-session-1",
      "--tools",
      "read,write,edit,bash,grep,find,ls",
    ]);
  });

  test("injects auth.json and settings.json into the sandbox container", async () => {
    const commands: Array<readonly string[]> = [];
    const sandboxService: SandboxClient = {
      startProvisioning() {},
      async ensureSession() { return sandbox; },
      async exec(_session, command) {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async execStream() { return { stdout: "", stderr: "", exitCode: 0 }; },
      async destroySession() {},
    };

    await injectPiAgentConfig(sandboxService, sandbox, {
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      apiKey: "sk-or-v1-test",
      thinkingLevel: "medium",
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.[0]).toBe("bash");
    expect(commands[0]?.[2]).toContain("/root/.pi/agent/auth.json");
    expect(commands[0]?.[2]).toContain('"openrouter"');
    expect(commands[0]?.[2]).toContain("sk-or-v1-test");
    expect(commands[0]?.[2]).toContain("defaultProvider");
    expect(commands[0]?.[2]).toContain("google/gemini-3.1-flash-lite");
  });
});
