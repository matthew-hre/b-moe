import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import type { Env } from "../config/env";

export interface GenerateTextInput {
  readonly system?: string;
  readonly prompt: string;
  readonly model?: string;
}

export interface LlmClient {
  generateText(input: GenerateTextInput): Promise<string>;
}

export interface LlmServiceDependencies {
  readonly env: Env;
  readonly generateTextFn?: typeof generateText;
  readonly createModel?: (modelId: string) => LanguageModel;
}

export class MissingOpenRouterConfigError extends Error {
  constructor() {
    super("OPENROUTER_API_KEY is required for LLM generation");
    this.name = "MissingOpenRouterConfigError";
  }
}

export class LlmService implements LlmClient {
  private readonly env: Env;
  private readonly generateTextFn: typeof generateText;
  private readonly createModel: (modelId: string) => LanguageModel;

  constructor({ env, generateTextFn = generateText, createModel }: LlmServiceDependencies) {
    this.env = env;
    this.generateTextFn = generateTextFn;
    this.createModel = createModel ?? this.createOpenRouterModelFactory(env);
  }

  async generateText(input: GenerateTextInput): Promise<string> {
    const result = await this.generateTextFn({
      model: this.createModel(input.model ?? this.env.openrouterModel),
      system: input.system,
      prompt: input.prompt,
    });

    return result.text.trim();
  }

  private createOpenRouterModelFactory(env: Env): (modelId: string) => LanguageModel {
    if (!env.openrouterApiKey) {
      throw new MissingOpenRouterConfigError();
    }

    const openrouter = createOpenAICompatible({
      name: "openrouter",
      apiKey: env.openrouterApiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });

    return (modelId) => openrouter(modelId);
  }
}
