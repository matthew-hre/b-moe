import { createLogger } from "../logger";
import type { LlmClient } from "./llm.service";

const logger = createLogger("commit-gen-service");

export interface CommitPlan {
  readonly message: string;
  readonly files: readonly string[];
}

export interface GenerationResult {
  readonly prTitle: string;
  readonly description: string;
  readonly commits: readonly CommitPlan[];
}

export interface CommitGenClient {
  generate(input: CommitGenInput): Promise<GenerationResult>;
}

export interface CommitGenInput {
  readonly linearIssueId?: string;
  readonly summary: string;
  readonly changedFiles: readonly ChangedFile[];
}

export interface ChangedFile {
  readonly status: string;
  readonly path: string;
}

export interface CommitGenServiceDependencies {
  readonly llmService: LlmClient;
}

const PR_TITLE_PROMPT = `You are generating structured git metadata for a pull request.

Given the implementation summary and list of changed files, produce:
1. A PR title — short, descriptive, using conventional-commit style (e.g. "feat: add user authentication"). Do NOT include the issue ID prefix; it will be prepended automatically.
2. A PR description — well-structured Markdown with clear sections (## Summary, ## Changes, etc.). Use bullet lists, code blocks, and headers as appropriate. Do NOT just dump a wall of text.
3. A list of conventional commits — group related file changes into separate commits. Each commit needs a conventional-commit message (type(scope): description) and the list of files to include. Use types: feat, fix, refactor, test, docs, chore, style, perf, ci, build. Include ALL changed files across the commits.

Respond ONLY with valid JSON in this exact shape (no markdown fences, no extra text):
{
  "prTitle": "feat: short description",
  "description": "## Summary\\n\\n...\\n\\n## Changes\\n\\n- ...",
  "commits": [
    { "message": "feat(scope): description", "files": ["path/to/file.ts"] },
    { "message": "test: add tests for feature", "files": ["tests/feature.test.ts"] }
  ]
}`;

export class CommitGenService implements CommitGenClient {
  private readonly llmService: LlmClient;

  constructor({ llmService }: CommitGenServiceDependencies) {
    this.llmService = llmService;
  }

  async generate(input: CommitGenInput): Promise<GenerationResult> {
    const fileListing = input.changedFiles
      .map((f) => `${f.status}\t${f.path}`)
      .join("\n");

    const prompt = [
      `Issue ID: ${input.linearIssueId ?? "unknown"}`,
      "",
      "Implementation summary:",
      input.summary,
      "",
      "Changed files (status\\tpath):",
      fileListing || "(none)",
    ].join("\n");

    try {
      const raw = await this.llmService.generateText({
        system: PR_TITLE_PROMPT,
        prompt,
      });

      return parseGenerationResult(raw, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`LLM commit generation failed, falling back to defaults: ${message}`);

      return buildFallbackResult(input);
    }
  }
}

function parseGenerationResult(raw: string, input: CommitGenInput): GenerationResult {
  const jsonText = extractJson(raw);

  if (!jsonText) {
    logger.warn("Could not extract JSON from LLM response, falling back to defaults");
    return buildFallbackResult(input);
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;

    if (!isRecord(parsed)) {
      return buildFallbackResult(input);
    }

    const prTitle = typeof parsed.prTitle === "string" && parsed.prTitle.trim()
      ? parsed.prTitle.trim()
      : buildFallbackTitle(input);

    const description = typeof parsed.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : buildFallbackDescription(input);

    const commits = parseCommits(parsed.commits, input);

    return { prTitle, description, commits };
  } catch {
    logger.warn("Failed to parse LLM JSON response, falling back to defaults");
    return buildFallbackResult(input);
  }
}

function parseCommits(value: unknown, input: CommitGenInput): CommitPlan[] {
  if (!Array.isArray(value) || value.length === 0) {
    return buildFallbackCommits(input);
  }

  const allFiles = new Set(input.changedFiles.map((f) => f.path));
  const assignedFiles = new Set<string>();
  const commits: CommitPlan[] = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.message !== "string" || !Array.isArray(item.files)) {
      continue;
    }

    const files = (item.files as unknown[])
      .filter((f): f is string => typeof f === "string" && allFiles.has(f));

    if (files.length === 0 || !item.message.trim()) {
      continue;
    }

    for (const f of files) {
      assignedFiles.add(f);
    }

    commits.push({ message: item.message.trim(), files });
  }

  if (commits.length === 0) {
    return buildFallbackCommits(input);
  }

  const unassigned = input.changedFiles
    .map((f) => f.path)
    .filter((f) => !assignedFiles.has(f));

  if (unassigned.length > 0) {
    commits.push({
      message: "chore: apply remaining changes",
      files: unassigned,
    });
  }

  return commits;
}

function buildFallbackResult(input: CommitGenInput): GenerationResult {
  return {
    prTitle: buildFallbackTitle(input),
    description: buildFallbackDescription(input),
    commits: buildFallbackCommits(input),
  };
}

function buildFallbackTitle(input: CommitGenInput): string {
  const prefix = input.linearIssueId ? `${input.linearIssueId}: ` : "";
  const firstLine = input.summary.split("\n")[0]?.trim() ?? "implementation";

  return `${prefix}${firstLine}`;
}

function buildFallbackDescription(input: CommitGenInput): GenerationResult["description"] {
  const sections = ["## Summary", "", input.summary];

  if (input.changedFiles.length > 0) {
    sections.push("", "## Changed files", "");
    for (const file of input.changedFiles) {
      sections.push(`- \`${file.path}\` (${file.status})`);
    }
  }

  return sections.join("\n");
}

function buildFallbackCommits(input: CommitGenInput): CommitPlan[] {
  const prefix = input.linearIssueId ? `${input.linearIssueId}: ` : "";
  const allFiles = input.changedFiles.map((f) => f.path);

  if (allFiles.length === 0) {
    return [];
  }

  return [
    {
      message: `${prefix}implement changes`,
      files: allFiles,
    },
  ];
}

function extractJson(text: string): string | undefined {
  const trimmed = text.trim();

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    return candidate;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
