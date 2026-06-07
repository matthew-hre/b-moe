import type { Run } from "../models/run";
import type { Env } from "../config/env";
import type { SandboxClient, SandboxSession } from "./sandbox.service";
import {
  buildPiArgs,
  injectPiAgentConfig,
  MissingPiCredentialsError,
  resolvePiAgentConfig,
} from "./pi-config";

export interface PiActResult {
  readonly summary: string;
  readonly stopReason: string;
  readonly toolCallCount: number;
}

export interface PiClient {
  act(input: { run: Run; sandbox: SandboxSession; onThought?: (thought: string) => Promise<void>; onProgress?: (message: string) => Promise<void> }): Promise<PiActResult>;
}

export interface PiRpcRunInput {
  readonly sandbox: SandboxSession;
  readonly prompt: string;
  readonly command: string;
  readonly args: readonly string[];
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
    const config = resolvePiAgentConfig(this.env);

    if (!config) {
      throw new MissingPiCredentialsError();
    }

    await injectPiAgentConfig(this.sandboxService, sandbox, config);

    const events = await this.rpcRunner.run({
      sandbox,
      prompt: buildActPrompt(run, sandbox),
      command: this.env.piCommand,
      args: buildPiArgs(config, this.env),
      onThought,
      onProgress,
    });
    const agentEnd = events.find(isAgentEndEvent);
    const messages = agentEnd?.messages ?? events.filter(isMessageEndEvent).map((event) => event.message);

    if (messages.length === 0) {
      throw new Error(`Pi RPC completed without an agent_end event; events=${summarizeEventTypes(events)}`);
    }

    const assistantMessages = messages.filter(isAssistantMessage);
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
    const summary = extractText(lastAssistantMessage) || "Pi completed without a text summary.";

    return {
      summary,
      stopReason: lastAssistantMessage?.stopReason ?? "unknown",
      toolCallCount: events.filter(isToolExecutionStartEvent).length,
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

function createPiEventParser(input: Pick<PiRpcRunInput, "onThought" | "onProgress">) {
  const events: unknown[] = [];
  const thoughtPromises: Promise<void>[] = [];
  const progressPromises: Promise<void>[] = [];
  let buffer = "";

  const consume = (chunk: string) => {
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

function buildActPrompt(run: Run, sandbox: SandboxSession): string {
  return [
    "Implement the approved plan for this Linear issue.",
    `Run ID: ${run.id}`,
    run.linearIssueId ? `Linear issue ID: ${run.linearIssueId}` : undefined,
    `Repository branch: ${sandbox.branchName}`,
    run.plan ? `Approved plan:\n${run.plan}` : undefined,
    run.promptContext ? `Linear context:\n${run.promptContext}` : undefined,
    "Make the code changes in this working tree and run the most relevant checks you can infer from the project.",
    "Do not create, rename, switch, or push git branches. Stay on the provided repository branch; B-MOE will push the branch and open the pull request after you finish.",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

interface AgentEndEvent {
  readonly type: "agent_end";
  readonly messages: readonly unknown[];
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
      ? content.arguments.command.split("\n")[0]
      : undefined;

    if (content.name === "bash" && command) {
      return [`Running \`${command.slice(0, 120)}\``];
    }
    if ((content.name === "read" || content.name === "write" || content.name === "edit") && isRecord(content.arguments) && typeof content.arguments.path === "string") {
      return [`${capitalize(content.name)}ing \`${content.arguments.path}\``];
    }

    return [`Using ${content.name}`];
  });
}

function summarizeToolResult(event: ToolExecutionEndEvent): string | undefined {
  const text = JSON.stringify(event).slice(0, 1000);

  if (/Found 0 warnings and 0 errors|\bpass\)/i.test(text)) {
    return "Checks are passing so far.";
  }
  if (/Successfully wrote/i.test(text)) {
    return "Updated files in the workspace.";
  }
  if (/\bcreate mode\b|\d+ files? changed/i.test(text)) {
    return "Committed local changes.";
  }

  return undefined;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
