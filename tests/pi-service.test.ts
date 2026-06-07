import { describe, expect, test } from "bun:test";
import { PiService, type PiRpcRunInput } from "../src/services/pi.service";
import { loadEnv } from "../src/config/env";
import type { Run } from "../src/models/run";
import type { SandboxClient, SandboxSession } from "../src/services/sandbox.service";

const now = new Date("2025-01-01T00:00:00.000Z");
const run: Run = {
  id: "run-1",
  agentSessionId: "session-1",
  linearIssueId: "ENG-123",
  plan: "1. Change the code\n2. Run tests",
  state: "acting",
  createdAt: now,
  updatedAt: now,
};
const sandbox: SandboxSession = {
  id: "sandbox-run-1",
  runId: "run-1",
  containerId: "container-1",
  workingDirectory: "/workspace",
  branchName: "b-moe/eng-123",
};
const fakeSandboxService: SandboxClient = {
  startProvisioning() {},
  async ensureSession() { return sandbox; },
  async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
  async execStream() { return { stdout: "", stderr: "", exitCode: 0 }; },
  async destroySession() {},
};

describe("PiService", () => {
  test("runs Pi RPC with configured args and extracts the final result", async () => {
    let rpcInput: PiRpcRunInput | undefined;
    const service = new PiService({
      env: loadEnv({
        REDIS_HOST: "localhost",
        PI_COMMAND: "pi-dev",
        PI_PROVIDER: "anthropic",
        PI_MODEL: "claude-sonnet-4-20250514",
        PI_API_KEY: "pi-key-1",
        PI_THINKING_LEVEL: "medium",
        PI_TOOLS: "read,bash,edit",
      }),
      sandboxService: fakeSandboxService,
      rpcRunner: {
        async run(input) {
          rpcInput = input;
          return [
            { type: "tool_execution_start", toolName: "edit" },
            {
              type: "agent_end",
              messages: [
                {
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: "I should make a small edit." },
                    { type: "text", text: "Implemented the change." },
                  ],
                  stopReason: "stop",
                },
              ],
            },
          ];
        },
      },
    });

    await expect(service.act({ run, sandbox })).resolves.toEqual({
      summary: "Implemented the change.",
      stopReason: "stop",
      toolCallCount: 1,
    });
    expect(rpcInput).toMatchObject({
      command: "pi-dev",
      sandbox,
      args: [
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--offline",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-20250514",
        "--api-key",
        "pi-key-1",
        "--thinking",
        "medium",
        "--tools",
        "read,bash,edit",
      ],
    });
    expect(rpcInput?.prompt).toContain("Implement the approved plan");
    expect(rpcInput?.prompt).toContain("ENG-123");
    expect(rpcInput?.prompt).toContain("b-moe/eng-123");
  });

  test("defaults the sandbox pi command to pi", async () => {
    let rpcInput: PiRpcRunInput | undefined;
    const service = new PiService({
      env: loadEnv({
        REDIS_HOST: "localhost",
        OPENROUTER_API_KEY: "sk-or-v1-test",
      }),
      sandboxService: fakeSandboxService,
      rpcRunner: {
        async run(input) {
          rpcInput = input;
          return [
            {
              type: "agent_end",
              messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
            },
          ];
        },
      },
    });

    await service.act({ run, sandbox });

    expect(rpcInput?.command).toBe("pi");
  });

  test("throws when Pi exits without agent_end", async () => {
    const service = new PiService({
      env: loadEnv({ REDIS_HOST: "localhost", OPENROUTER_API_KEY: "sk-or-v1-test" }),
      sandboxService: fakeSandboxService,
      rpcRunner: { async run() { return []; } },
    });

    await expect(service.act({ run, sandbox })).rejects.toThrow("without an agent_end event");
  });

  test("falls back to OpenRouter credentials when PI_* is unset", async () => {
    let rpcInput: PiRpcRunInput | undefined;
    const service = new PiService({
      env: loadEnv({
        REDIS_HOST: "localhost",
        OPENROUTER_API_KEY: "sk-or-v1-test",
        OPENROUTER_MODEL: "google/gemini-3.1-flash-lite",
        PI_THINKING_LEVEL: "medium",
      }),
      sandboxService: fakeSandboxService,
      rpcRunner: {
        async run(input) {
          rpcInput = input;
          return [
            {
              type: "agent_end",
              messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
            },
          ];
        },
      },
    });

    await service.act({ run, sandbox });

    expect(rpcInput?.args).toEqual([
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--offline",
      "--provider",
      "openrouter",
      "--model",
      "google/gemini-3.1-flash-lite",
      "--api-key",
      "sk-or-v1-test",
      "--thinking",
      "medium",
    ]);
  });

  test("extracts final result from message_end events", async () => {
    const service = new PiService({
      env: loadEnv({ REDIS_HOST: "localhost", OPENROUTER_API_KEY: "sk-or-v1-test" }),
      sandboxService: fakeSandboxService,
      rpcRunner: {
        async run() {
          return [
            { type: "message_end", message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Implemented via message_end." }],
                stopReason: "stop",
              },
            },
          ];
        },
      },
    });

    await expect(service.act({ run, sandbox })).resolves.toEqual({
      summary: "Implemented via message_end.",
      stopReason: "stop",
      toolCallCount: 0,
    });
  });
});
