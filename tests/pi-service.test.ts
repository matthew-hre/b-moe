import { describe, expect, test } from "bun:test";
import { PiService, type PiRpcRunInput } from "../src/services/pi.service";
import { loadEnv } from "../src/config/env";
import type { Run } from "../src/models/run";
import type { SandboxClient, SandboxSession } from "../src/services/sandbox.service";
import { InMemorySteeringStore } from "../src/store/steering.store";

const now = new Date("2025-01-01T00:00:00.000Z");
const run: Run = {
  id: "run-1",
  agentSessionId: "session-1",
  linearIssueId: "ENG-123",
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
  async destroyRunSandbox() {},
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
      kind: "completed",
      summary: "Implemented the change.",
      stopReason: "stop",
      toolCallCount: 1,
    });
    expect(rpcInput).toMatchObject({
      command: "pi-dev",
      sandbox,
      args: [
        "--mode",
        "rpc",
        "--offline",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-20250514",
        "--api-key",
        "pi-key-1",
        "--name",
        "run-1",
        "--thinking",
        "medium",
        "--tools",
        "read,bash,edit",
      ],
    });
    expect(rpcInput?.prompt).toContain("implementation mode");
    expect(rpcInput?.prompt).toContain("ENG-123");
    expect(rpcInput?.prompt).toContain("b-moe/eng-123");
  });

  test("resumes a saved Pi session when the run has a session id", async () => {
    let rpcInput: PiRpcRunInput | undefined;
    const service = new PiService({
      env: loadEnv({ REDIS_HOST: "localhost", OPENROUTER_API_KEY: "sk-or-v1-test" }),
      sandboxService: fakeSandboxService,
      rpcRunner: {
        async run(input) {
          rpcInput = input;
          return [
            {
              type: "session",
              id: "pi-session-1",
              timestamp: "2026-01-01T00:00:00.000Z",
              cwd: "/workspace",
            },
            {
              type: "agent_end",
              messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
            },
          ];
        },
      },
    });

    await expect(service.act({
      run: { ...run, piSessionId: "pi-session-1" },
      sandbox,
    })).resolves.toMatchObject({
      kind: "completed",
      sessionId: "pi-session-1",
    });
    expect(rpcInput?.args).toContain("--session");
    expect(rpcInput?.args).toContain("pi-session-1");
    expect(rpcInput?.args).not.toContain("--name");
  });

  test("includes previous execution context and human replies in the act prompt", async () => {
    let rpcInput: PiRpcRunInput | undefined;
    const service = new PiService({
      env: loadEnv({ REDIS_HOST: "localhost", OPENROUTER_API_KEY: "sk-or-v1-test" }),
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

    await service.act({
      run: {
        ...run,
        executionContext: "README.md is missing and package scripts are in package.json.",
        latestPromptBody: "Use this image URL: https://example.com/bmo.png",
      },
      sandbox,
    });

    expect(rpcInput?.prompt).toContain("# Previous execution context");
    expect(rpcInput?.prompt).toContain("README.md is missing");
    expect(rpcInput?.prompt).toContain("# Human reply");
    expect(rpcInput?.prompt).toContain("https://example.com/bmo.png");
  });

  test("reports clean progress for tool calls", async () => {
    const progress: string[] = [];
    const streamingSandboxService: SandboxClient = {
      ...fakeSandboxService,
      async execStream(_session, _command, handlers) {
        const events = [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", name: "bash", arguments: { command: "# Checking package scripts\nbun test" } },
                { type: "toolCall", name: "bash", arguments: { command: "# Final verification: check requirements" } },
                { type: "toolCall", name: "write", arguments: { path: "README.md" } },
              ],
            },
          },
          {
            type: "tool_execution_end",
            result: { exitCode: 1, stdout: "(pass) one test\n(fail) another test" },
          },
          {
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
          },
        ];
        for (const event of events) {
          handlers.onStdoutChunk?.(`${JSON.stringify(event)}\n`);
        }

        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const service = new PiService({
      env: loadEnv({ REDIS_HOST: "localhost", OPENROUTER_API_KEY: "sk-or-v1-test" }),
      sandboxService: streamingSandboxService,
    });

    await service.act({
      run,
      sandbox,
      onProgress: async (message) => {
        progress.push(message);
      },
    });

    expect(progress).toEqual([
      "Running `bun test`",
      "Writing `README.md`",
    ]);
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
      "rpc",
      "--offline",
      "--provider",
      "openrouter",
      "--model",
      "google/gemini-3.1-flash-lite",
      "--api-key",
      "sk-or-v1-test",
      "--name",
      "run-1",
      "--thinking",
      "medium",
      "--tools",
      "read,write,edit,bash,grep,find,ls",
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
      kind: "completed",
      summary: "Implemented via message_end.",
      stopReason: "stop",
      toolCallCount: 0,
    });
  });

  test("flushes queued steering when an RPC session is ready", async () => {
    const steeredMessages: string[] = [];
    const steeringStore = new InMemorySteeringStore({
      createMessageId: () => "steering-1",
      getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
    });
    await steeringStore.enqueue({ runId: run.id, body: "Use the v2 API instead." });
    const service = new PiService({
      env: loadEnv({ REDIS_HOST: "localhost", OPENROUTER_API_KEY: "sk-or-v1-test" }),
      sandboxService: fakeSandboxService,
      steeringStore,
      rpcRunner: {
        async run(input) {
          await input.onReady?.({
            async prompt() {},
            async steer(message) {
              steeredMessages.push(message);
            },
            async followUp() {},
            async abort() {},
          });

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

    expect(steeredMessages).toEqual(["Use the v2 API instead."]);
    expect(await steeringStore.drain(run.id)).toEqual([]);
  });
});
