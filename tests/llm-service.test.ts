import { describe, expect, test } from "bun:test";
import { LlmService, MissingOpenRouterConfigError } from "../src/services/llm.service";
import type { GenerateTextInput } from "../src/services/llm.service";
import { loadEnv } from "../src/config/env";

describe("LlmService", () => {
  test("generates text with the configured OpenRouter model", async () => {
    const calls: Array<{ model: unknown; system?: string; prompt: string }> = [];
    const service = new LlmService({
      env: loadEnv({
        REDIS_HOST: "localhost",
        OPENROUTER_API_KEY: "openrouter-key-1",
        OPENROUTER_MODEL: "google/gemini-3.1-flash-lite",
      }),
      createModel: (modelId) => ({ modelId }) as never,
      generateTextFn: (async (input: GenerateTextInput & { model: unknown }) => {
        calls.push({ model: input.model, system: input.system as string | undefined, prompt: input.prompt as string });
        return { text: " generated text \n" };
      }) as never,
    });

    const text = await service.generateText({ system: "system", prompt: "prompt" });

    expect(text).toBe("generated text");
    expect(calls).toEqual([
      { model: { modelId: "google/gemini-3.1-flash-lite" }, system: "system", prompt: "prompt" },
    ]);
  });

  test("throws when OpenRouter key is missing and no model factory is injected", () => {
    expect(() => new LlmService({ env: loadEnv({ REDIS_HOST: "localhost" }) })).toThrow(
      MissingOpenRouterConfigError,
    );
  });
});
