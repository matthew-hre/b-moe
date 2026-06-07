import type { Run } from "../models/run";
import type { LlmClient } from "./llm.service";

export interface PlanningClient {
  createPlan(run: Run): Promise<string>;
}

export interface PlanningServiceDependencies {
  readonly llmService: LlmClient;
}

export class PlanningService implements PlanningClient {
  private readonly llmService: LlmClient;

  constructor({ llmService }: PlanningServiceDependencies) {
    this.llmService = llmService;
  }

  async createPlan(run: Run): Promise<string> {
    const title = extractIssueTitle(run.promptContext) ?? "the Linear issue";

    return this.llmService.generateText({
      system: "You are B-MOE, an autonomous coding agent. Produce concise, actionable implementation plans.",
      prompt: [
        `Create a short implementation plan for ${title}.`,
        run.latestPromptBody ? `Revise the plan using this human feedback: ${run.latestPromptBody}` : undefined,
        "Return only the plan as a numbered list with no preamble.",
        "Linear prompt context:",
        run.promptContext ?? "No prompt context was provided.",
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n"),
    });
  }
}

function extractIssueTitle(promptContext: string | undefined): string | undefined {
  if (!promptContext) {
    return undefined;
  }

  return promptContext.match(/<title>(?<title>.*?)<\/title>/s)?.groups?.title?.trim() || undefined;
}
