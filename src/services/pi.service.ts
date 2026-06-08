import type { Run } from "../models/run";
import type { Env } from "../config/env";
import type { SandboxClient, SandboxSession } from "./sandbox.service";
import {
  buildPiArgs,
  injectPiAgentConfig,
  MissingPiCredentialsError,
  resolvePiAgentConfig,
} from "./pi-config";
import { buildActPrompt, parseActResponse } from "./pi-prompts";

export interface PiAgentResult {
  readonly text: string;
  readonly stopReason: string;
  readonly toolCallCount: number;
  readonly sessionId?: string;
}

interface PiActResultBase {
  readonly stopReason: string;
  readonly toolCallCount: number;
  readonly sessionId?: string;
}

export type PiActResult =
  | (PiActResultBase & {
      readonly kind: "completed";
      readonly summary: string;
    })
  | (PiActResultBase & {
      readonly kind: "needs_input";
      readonly question: string;
      readonly context?: string;
    });

export interface PiClient {
  act(input: { run: Run; sandbox: SandboxSession; onThought?: (thought: string) => Promise<void>; onProgress?: (message: string) => Promise<void> }): Promise<PiActResult>;
}

export interface PiRpcRunInput {
  readonly sandbox: SandboxSession;
  readonly prompt: string;
  readonly command: string;
  readonly args: readonly string[];
    readonly sessionId?: string;
  readonly onThought?: (thought: string) => Promise<void>;
  readonly onProgress?: (message: string) => Promise<void>;
}

export interface PiRpcRunner {
  run(input: PiRpcRunInput): Promise<readonly unknown[]>;
}

export interface PiServiceDependencies {
  readonly env: Env;
  readonly sandboxService: SandboxClient;
  readonly rpcRunner?: PiRpcRunner;
}

export class PiService implements PiClient {
  private readonly env: Env;
  private readonly sandboxService: SandboxClient;
  private readonly rpcRunner: PiRpcRunner;

  constructor({ env, sandboxService, rpcRunner }: PiServiceDependencies) {
    this.env = env;
    this.sandboxService = sandboxService;
    this.rpcRunner = rpcRunner ?? new SandboxPiRpcRunner(sandboxService);
  }

  async act({ run, sandbox, onThought, onProgress }: { run: Run; sandbox: SandboxSession; onThought?: (thought: string) => Promise<void>; onProgress?: (message: string) => Promise<void> }): Promise<PiActResult> {
    const result = await this.runPiAgent({
      sandbox,
      prompt: buildActPrompt(run, sandbox),
      sessionId: run.piSessionId,
      onThought,
      onProgress,
    });
    const actResponse = parseActResponse(result.text || "Pi completed without a text summary.");
    const response = {
      ...actResponse,
      stopReason: result.stopReason,
      toolCallCount: result.toolCallCount,
    };

    return result.sessionId ? { ...response, sessionId: result.sessionId } : response;
  }

  private async runPiAgent({
    sandbox,
    prompt,
    sessionId,
    onThought,
    onProgress,
  }: {
    readonly sandbox: SandboxSession;
    readonly prompt: string;
    readonly sessionId?: string;
    readonly onThought?: (thought: string) => Promise<void>;
    readonly onProgress?: (message: string) => Promise<void>;
  }): Promise<PiAgentResult> {
    const config = resolvePiAgentConfig(this.env);

    if (!config) {
      throw new MissingPiCredentialsError();
    }

    await injectPiAgentConfig(this.sandboxService, sandbox, config);

    const events = await this.rpcRunner.run({
      sandbox,
      prompt,
      command: this.env.piCommand,
      args: buildPiArgs(config, this.env, {
        sessionId,
        sessionName: sandbox.runId,
      }),
      onThought,
      onProgress,
    });
    const sessionEvent = events.find(isSessionEvent);
    const agentEnd = events.find(isAgentEndEvent);
    const messages = agentEnd?.messages ?? events.filter(isMessageEndEvent).map((event) => event.message);

    if (messages.length === 0) {
      throw new Error(`Pi RPC completed without an agent_end event; events=${summarizeEventTypes(events)}`);
    }

    const assistantMessages = messages.filter(isAssistantMessage);
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
    const text = extractText(lastAssistantMessage);

    return {
      text,
      stopReason: lastAssistantMessage?.stopReason ?? "unknown",
      toolCallCount: events.filter(isToolExecutionStartEvent).length,
      sessionId: sessionEvent?.id,
    };
  }
}

export class SandboxPiRpcRunner implements PiRpcRunner {
  constructor(private readonly sandboxService: SandboxClient) {}

  async run(input: PiRpcRunInput): Promise<readonly unknown[]> {
    console.log(
      `[pi-service] exec ${sanitizePiExecLog(input.command, input.args)} containerId=${input.sandbox.containerId} cwd=${input.sandbox.workingDirectory}`,
    );
    const parser = createPiEventParser(input);
    const result = await this.sandboxService.execStream(
      input.sandbox,
      [input.command, ...input.args, input.prompt],
      {
        onStdoutChunk: (chunk) => {
          parser.consume(chunk);
        },
      },
    );

    await parser.flush();

    console.log(
      `[pi-service] container exec finished code=${result.exitCode} events=${parser.events.length} stderr=${result.stderr.slice(0, 500)}`,
    );

    if (result.exitCode !== 0) {
      throw new Error(`Pi RPC exited with code ${result.exitCode}: ${result.stderr}`);
    }

    return parser.events;
  }
}

interface PiEventParser {
  readonly events: unknown[];
  consume(chunk: string): void;
  flush(): Promise<void>;
}

function createPiEventParser(input: Pick<PiRpcRunInput, "onThought" | "onProgress">): PiEventParser {
  const events: unknown[] = [];
  const thoughtPromises: Promise<void>[] = [];
  const progressPromises: Promise<void>[] = [];
  let buffer = "";

  const consume = (chunk: string): void => {
    buffer += chunk;
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (!line.trim()) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        events.push(event);
        if (isRecord(event)) {
          console.log(`[pi-service] rpc event type=${String(event.type ?? "unknown")}`);
          if (isMessageEndEvent(event) && isAssistantMessage(event.message)) {
            for (const thought of extractThinking([event.message])) {
              const promise = input.onThought?.(thought);
              if (promise) {
                thoughtPromises.push(promise);
              }
            }
            for (const progress of extractToolCallProgress(event.message)) {
              const promise = input.onProgress?.(progress);
              if (promise) {
                progressPromises.push(promise);
              }
            }
          }
          if (isToolExecutionEndEvent(event)) {
            const progress = summarizeToolResult(event);
            if (progress) {
              const promise = input.onProgress?.(progress);
              if (promise) {
                progressPromises.push(promise);
              }
            }
          }
        }
      } catch {
        console.log(`[pi-service] non-json stdout: ${line.slice(0, 500)}`);
      }
    }
  };

  return {
    events,
    consume,
    async flush() {
      await Promise.all([...thoughtPromises, ...progressPromises]);
    },
  };
}

function sanitizePiExecLog(command: string, args: readonly string[]): string {
  const sanitizedArgs = args.flatMap((arg, index, all) => {
    if (all[index - 1] === "--api-key") {
      return ["--api-key", "***"];
    }

    return arg === "--api-key" ? [] : [arg];
  });

  return `${command} ${sanitizedArgs.join(" ")}`;
}

interface AgentEndEvent {
  readonly type: "agent_end";
  readonly messages: readonly unknown[];
}

interface SessionEvent {
  readonly type: "session";
  readonly id: string;
}

interface MessageEndEvent {
  readonly type: "message_end";
  readonly message: unknown;
}

interface AssistantMessage {
  readonly role: "assistant";
  readonly content?: readonly unknown[];
  readonly stopReason?: string;
}

interface ToolExecutionStartEvent {
  readonly type: "tool_execution_start";
}

interface ToolExecutionEndEvent {
  readonly type: "tool_execution_end";
  readonly result?: unknown;
  readonly message?: unknown;
}

function isAgentEndEvent(event: unknown): event is AgentEndEvent {
  return isRecord(event) && event.type === "agent_end" && Array.isArray(event.messages);
}

function isSessionEvent(event: unknown): event is SessionEvent {
  return isRecord(event) && event.type === "session" && typeof event.id === "string";
}

function isMessageEndEvent(event: unknown): event is MessageEndEvent {
  return isRecord(event) && event.type === "message_end" && "message" in event;
}

function summarizeEventTypes(events: readonly unknown[]): string {
  if (events.length === 0) {
    return "none";
  }

  return events.map((event) => isRecord(event) ? String(event.type ?? "unknown") : typeof event).join(",");
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return isRecord(message) && message.role === "assistant";
}

function isToolExecutionStartEvent(event: unknown): event is ToolExecutionStartEvent {
  return isRecord(event) && event.type === "tool_execution_start";
}

function isToolExecutionEndEvent(event: unknown): event is ToolExecutionEndEvent {
  return isRecord(event) && event.type === "tool_execution_end";
}

function extractText(message: AssistantMessage | undefined): string {
  if (!message?.content) {
    return "";
  }

  return message.content
    .filter((content): content is { type: "text"; text: string } => {
      return isRecord(content) && content.type === "text" && typeof content.text === "string";
    })
    .map((content) => content.text)
    .join("");
}

function extractThinking(messages: readonly AssistantMessage[]): readonly string[] {
  return messages.flatMap((message) => message.content ?? [])
    .filter((content): content is { type: "thinking"; thinking: string } => {
      return isRecord(content) && content.type === "thinking" && typeof content.thinking === "string";
    })
    .map((content) => content.thinking.trim())
    .filter(Boolean);
}

function extractToolCallProgress(message: AssistantMessage): readonly string[] {
  return (message.content ?? []).flatMap((content) => {
    if (!isRecord(content) || content.type !== "toolCall" || typeof content.name !== "string") {
      return [];
    }

    const command = isRecord(content.arguments) && typeof content.arguments.command === "string"
      ? summarizeShellCommand(content.arguments.command)
      : undefined;

    if (content.name === "bash") {
      return command ? [`Running \`${command.slice(0, 120)}\``] : [];
    }
    if ((content.name === "read" || content.name === "write" || content.name === "edit") && isRecord(content.arguments) && typeof content.arguments.path === "string") {
      return [`${formatFileToolProgress(content.name)} \`${content.arguments.path}\``];
    }

    return [`Using ${content.name}`];
  });
}

function summarizeToolResult(event: ToolExecutionEndEvent): string | undefined {
  const text = JSON.stringify(event).slice(0, 1000);
  const exitCode = extractExitCode(event.result);

  if (exitCode === 0 && /Found 0 warnings and 0 errors/i.test(text)) {
    return "Lint completed without reported errors.";
  }
  if (/Successfully wrote/i.test(text)) {
    return "Updated files in the workspace.";
  }
  if (/\bcreate mode\b|\d+ files? changed/i.test(text)) {
    return "Committed local changes.";
  }

  return undefined;
}

function summarizeShellCommand(command: string): string | undefined {
  return command
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
}

function formatFileToolProgress(toolName: string): string {
  if (toolName === "read") {
    return "Reading";
  }
  if (toolName === "write") {
    return "Writing";
  }
  if (toolName === "edit") {
    return "Editing";
  }

  return `Using ${toolName}`;
}

function extractExitCode(value: unknown): number | undefined {
  if (isRecord(value) && typeof value.exitCode === "number") {
    return value.exitCode;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
