import type { Run } from "../models/run";
import { createLogger } from "../logger";
import type { Env } from "../config/env";
import type { SandboxClient, SandboxExecResult, SandboxSession } from "./sandbox.service";
import {
  buildPiArgs,
  injectPiAgentConfig,
  MissingPiCredentialsError,
  resolvePiAgentConfig,
} from "./pi-config";
import { buildActPrompt, parseActResponse } from "./pi-prompts";
import type { SteeringStore } from "../store/steering.store";

const logger = createLogger("pi-service");

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
  steer(input: { runId: string; message: string }): Promise<boolean>;
}

export interface PiRpcRunInput {
  readonly sandbox: SandboxSession;
  readonly runId: string;
  readonly prompt: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly sessionId?: string;
  readonly onThought?: (thought: string) => Promise<void>;
  readonly onProgress?: (message: string) => Promise<void>;
  readonly onReady?: (session: PiRpcSession) => Promise<void>;
}

export interface PiRpcSession {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
}

export interface PiRpcRunner {
  run(input: PiRpcRunInput): Promise<readonly unknown[]>;
}

export interface PiServiceDependencies {
  readonly env: Env;
  readonly sandboxService: SandboxClient;
  readonly steeringStore?: SteeringStore;
  readonly rpcRunner?: PiRpcRunner;
}

export class PiService implements PiClient {
  private readonly env: Env;
  private readonly sandboxService: SandboxClient;
  private readonly steeringStore?: SteeringStore;
  private readonly rpcRunner: PiRpcRunner;
  private readonly activeSessions = new Map<string, PiRpcSession>();

  constructor({ env, sandboxService, steeringStore, rpcRunner }: PiServiceDependencies) {
    this.env = env;
    this.sandboxService = sandboxService;
    this.steeringStore = steeringStore;
    this.rpcRunner = rpcRunner ?? new SandboxPiRpcRunner(sandboxService);
  }

  async act({ run, sandbox, onThought, onProgress }: { run: Run; sandbox: SandboxSession; onThought?: (thought: string) => Promise<void>; onProgress?: (message: string) => Promise<void> }): Promise<PiActResult> {
    const result = await this.runPiAgent({
      sandbox,
      prompt: buildActPrompt(run, sandbox),
      sessionId: run.piSessionId,
      runId: run.id,
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

  async steer({ runId, message }: { runId: string; message: string }): Promise<boolean> {
    const session = this.activeSessions.get(runId);

    if (!session) {
      return false;
    }

    await session.steer(message);

    return true;
  }

  private async runPiAgent({
    sandbox,
    prompt,
    sessionId,
    runId,
    onThought,
    onProgress,
  }: {
    readonly sandbox: SandboxSession;
    readonly prompt: string;
    readonly sessionId?: string;
    readonly runId: string;
    readonly onThought?: (thought: string) => Promise<void>;
    readonly onProgress?: (message: string) => Promise<void>;
  }): Promise<PiAgentResult> {
    const config = resolvePiAgentConfig(this.env);

    if (!config) {
      throw new MissingPiCredentialsError();
    }

    await injectPiAgentConfig(this.sandboxService, sandbox, config);

    let pendingSteeringPoll: ReturnType<typeof setInterval> | undefined;
    let events: readonly unknown[];

    try {
      events = await this.rpcRunner.run({
        sandbox,
        runId,
        prompt,
        command: this.env.piCommand,
        args: buildPiArgs(config, this.env, {
          mode: "rpc",
          sessionId,
          sessionName: sandbox.runId,
        }),
        onThought,
        onProgress,
        onReady: async (session) => {
          this.activeSessions.set(runId, session);
          await this.flushPendingSteering(runId, session);
          pendingSteeringPoll = setInterval(() => {
            void this.flushPendingSteering(runId, session).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`failed to flush pending steering runId=${runId}: ${message}`);
            });
          }, 2000);
        },
      });
    } finally {
      if (pendingSteeringPoll) {
        clearInterval(pendingSteeringPoll);
      }
      this.activeSessions.delete(runId);
    }

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

  private async flushPendingSteering(runId: string, session: PiRpcSession): Promise<void> {
    const messages = await this.steeringStore?.drain(runId) ?? [];

    for (const message of messages) {
      logger.info(`delivering queued steering runId=${runId} messageId=${message.id}`);
      await session.steer(message.body);
    }
  }
}

export class SandboxPiRpcRunner implements PiRpcRunner {
  constructor(private readonly sandboxService: SandboxClient) {}

  async run(input: PiRpcRunInput): Promise<readonly unknown[]> {
    logger.info(
      `exec ${sanitizePiExecLog(input.command, input.args)} containerId=${input.sandbox.containerId} cwd=${input.sandbox.workingDirectory}`,
    );
    const fifoPath = `/tmp/b-moe-pi-${input.runId}.in`;
    const pidPath = `/tmp/b-moe-pi-${input.runId}.pid`;
    await this.prepareRpcPipe(input.sandbox, fifoPath, pidPath);
    let stoppedAfterAgentEnd = false;
    const parser = createPiEventParser({
      ...input,
      onAgentEnd: () => {
        stoppedAfterAgentEnd = true;
        void this.stopRpcProcess(input.sandbox, pidPath).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`failed to stop Pi RPC after agent_end runId=${input.runId}: ${message}`);
        });
      },
    });
    const command = buildRpcShellCommand(input.command, input.args, fifoPath, pidPath);
    const resultPromise = this.sandboxService.execStream(
      input.sandbox,
      ["bash", "-ec", command],
      {
        onStdoutChunk: (chunk) => {
          parser.consume(chunk);
        },
      },
    );
    const session = new SandboxPiRpcSession(this.sandboxService, input.sandbox, fifoPath);
    let result: SandboxExecResult;

    try {
      await session.prompt(input.prompt);
      await input.onReady?.(session);
      result = await resultPromise;
    } catch (error) {
      await this.stopRpcProcess(input.sandbox, pidPath);
      await resultPromise.catch(() => undefined);
      throw error;
    } finally {
      await this.cleanupRpcPipe(input.sandbox, fifoPath, pidPath);
    }

    await parser.flush();

    logger.info(
      `container exec finished code=${result.exitCode} events=${parser.events.length} stderr=${result.stderr.slice(0, 500)}`,
    );

    if (result.exitCode !== 0 && !stoppedAfterAgentEnd) {
      throw new Error(`Pi RPC exited with code ${result.exitCode}: ${result.stderr}`);
    }

    return parser.events;
  }

  private async prepareRpcPipe(sandbox: SandboxSession, fifoPath: string, pidPath: string): Promise<void> {
    const result = await this.sandboxService.exec(
      sandbox,
      ["bash", "-ec", `rm -f ${shellQuote(fifoPath)} ${shellQuote(pidPath)} && mkfifo ${shellQuote(fifoPath)}`],
      { workingDirectory: "/" },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to prepare Pi RPC pipe: ${result.stderr || result.stdout}`);
    }
  }

  private async stopRpcProcess(sandbox: SandboxSession, pidPath: string): Promise<void> {
    await this.sandboxService.exec(
      sandbox,
      ["bash", "-ec", `[ ! -s ${shellQuote(pidPath)} ] || kill "$(cat ${shellQuote(pidPath)})" 2>/dev/null || true`],
      { workingDirectory: "/" },
    );
  }

  private async cleanupRpcPipe(sandbox: SandboxSession, fifoPath: string, pidPath: string): Promise<void> {
    await this.sandboxService.exec(
      sandbox,
      ["bash", "-ec", `rm -f ${shellQuote(fifoPath)} ${shellQuote(pidPath)}`],
      { workingDirectory: "/" },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`failed to cleanup Pi RPC pipe runId=${sandbox.runId}: ${message}`);
    });
  }
}

class SandboxPiRpcSession implements PiRpcSession {
  constructor(
    private readonly sandboxService: SandboxClient,
    private readonly sandbox: SandboxSession,
    private readonly fifoPath: string,
  ) {}

  async prompt(message: string): Promise<void> {
    await this.send({ type: "prompt", message });
  }

  async steer(message: string): Promise<void> {
    await this.send({ type: "steer", message });
  }

  async followUp(message: string): Promise<void> {
    await this.send({ type: "follow_up", message });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  private async send(command: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(command);
    const result = await this.sandboxService.exec(
      this.sandbox,
      ["bash", "-ec", `printf '%s\\n' ${shellQuote(line)} > ${shellQuote(this.fifoPath)}`],
      { workingDirectory: "/" },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to send Pi RPC command: ${result.stderr || result.stdout}`);
    }
  }
}

interface PiEventParser {
  readonly events: unknown[];
  consume(chunk: string): void;
  flush(): Promise<void>;
}

function createPiEventParser(input: Pick<PiRpcRunInput, "onThought" | "onProgress"> & { readonly onAgentEnd?: () => void }): PiEventParser {
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
          logger.debug(`rpc event type=${String(event.type ?? "unknown")}`);
          if (isAgentEndEvent(event)) {
            input.onAgentEnd?.();
          }
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
        logger.warn(`non-json stdout: ${line.slice(0, 500)}`);
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

function buildRpcShellCommand(command: string, args: readonly string[], fifoPath: string, pidPath: string): string {
  return [
    `exec 3<>${shellQuote(fifoPath)}`,
    `${[command, ...args].map(shellQuote).join(" ")} < ${shellQuote(fifoPath)} &`,
    `echo $! > ${shellQuote(pidPath)}`,
    "wait $!",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
