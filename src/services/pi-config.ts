import type { Env } from "../config/env";
import type { SandboxClient, SandboxSession } from "./sandbox.service";

export interface ResolvedPiAgentConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  readonly thinkingLevel?: string;
}

export class MissingPiCredentialsError extends Error {
  constructor() {
    super("Pi requires API credentials; set PI_API_KEY or OPENROUTER_API_KEY");
    this.name = "MissingPiCredentialsError";
  }
}

export function resolvePiAgentConfig(env: Env): ResolvedPiAgentConfig | undefined {
  const apiKey = env.piApiKey ?? env.openrouterApiKey;

  if (!apiKey) {
    return undefined;
  }

  const provider = env.piProvider ?? (env.openrouterApiKey ? "openrouter" : undefined);
  const model = env.piModel ?? env.openrouterModel;

  if (!provider || !model) {
    return undefined;
  }

  return {
    provider,
    model,
    apiKey,
    thinkingLevel: env.piThinkingLevel,
  };
}

export function buildPiAuthJson(config: ResolvedPiAgentConfig): string {
  return JSON.stringify({
    [config.provider]: {
      type: "api_key",
      key: config.apiKey,
    },
  });
}

export function buildPiSettingsJson(config: ResolvedPiAgentConfig): string {
  return JSON.stringify({
    defaultProvider: config.provider,
    defaultModel: config.model,
    ...(config.thinkingLevel ? { defaultThinkingLevel: config.thinkingLevel } : {}),
  });
}

export interface BuildPiArgsOptions {
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly mode?: "json" | "rpc";
}

const DEFAULT_PI_TOOLS = "read,write,edit,bash,grep,find,ls";

export function buildPiArgs(config: ResolvedPiAgentConfig, env: Pick<Env, "piTools">, options: BuildPiArgsOptions = {}): string[] {
  const args = ["--mode", options.mode ?? "json", "--offline", "--provider", config.provider, "--model", config.model, "--api-key", config.apiKey];

  if (options.sessionId) {
    args.push("--session", options.sessionId);
  } else if (options.sessionName) {
    args.push("--name", options.sessionName);
  }

  if (config.thinkingLevel) {
    args.push("--thinking", config.thinkingLevel);
  }

  args.push("--tools", env.piTools ?? DEFAULT_PI_TOOLS);

  return args;
}

export async function injectPiAgentConfig(
  sandboxService: SandboxClient,
  session: SandboxSession,
  config: ResolvedPiAgentConfig,
): Promise<void> {
  const authJson = buildPiAuthJson(config);
  const settingsJson = buildPiSettingsJson(config);
  const script = [
    "mkdir -p /root/.pi/agent",
    `printf '%s' ${shellQuote(authJson)} > /root/.pi/agent/auth.json`,
    `printf '%s' ${shellQuote(settingsJson)} > /root/.pi/agent/settings.json`,
  ].join(" && ");
  const result = await sandboxService.exec(session, ["bash", "-ec", script], { workingDirectory: "/" });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to inject Pi agent config: ${result.stderr || result.stdout}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
