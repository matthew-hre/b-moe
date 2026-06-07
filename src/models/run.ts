import { z } from "zod";

export const runStates = [
  "queued",
  "refining",
  "planning",
  "acting",
  "awaiting_input",
  "pr_opened",
  "monitoring",
  "responding",
  "completed",
] as const;

export const RunStateSchema = z.enum(runStates);
export type RunState = z.infer<typeof RunStateSchema>;

export const PullRequestInfoSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.url(),
    branchName: z.string().min(1),
  })
  .strict();

export type PullRequestInfo = Readonly<z.infer<typeof PullRequestInfoSchema>>;

export const RunSchema = z
  .object({
    id: z.string().min(1),
    agentSessionId: z.string().min(1),
    linearIssueId: z.string().min(1).optional(),
    requesterUrl: z.url().optional(),
    requesterName: z.string().min(1).optional(),
    promptContext: z.string().min(1).optional(),
    repoUrl: z.url().optional(),
    baseBranch: z.string().min(1).optional(),
    repositorySelectionQuestion: z.string().min(1).optional(),
    latestPromptBody: z.string().min(1).optional(),
    plan: z.string().min(1).optional(),
    state: RunStateSchema,
    pausedFrom: RunStateSchema.optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
    pullRequest: PullRequestInfoSchema.optional(),
    completedAt: z.date().optional(),
  })
  .strict();

export type Run = Readonly<z.infer<typeof RunSchema>>;

// Phases the agent can pause from to wait on a human (`awaiting_input`), and
// resume back into when a `prompted` webhook arrives.
const pausablePhases = ["refining", "planning", "acting"] as const satisfies readonly RunState[];

const allowedTransitions = {
  queued: ["refining"],
  refining: ["planning", "awaiting_input"],
  planning: ["acting", "awaiting_input"],
  acting: ["pr_opened", "awaiting_input"],
  awaiting_input: pausablePhases,
  pr_opened: ["monitoring"],
  monitoring: ["responding", "completed"],
  responding: ["monitoring"],
  completed: [],
} satisfies Record<RunState, readonly RunState[]>;

export class InvalidRunStateTransitionError extends Error {
  constructor(
    readonly currentState: RunState,
    readonly nextState: RunState,
  ) {
    super(`Cannot transition run from ${currentState} to ${nextState}`);
    this.name = "InvalidRunStateTransitionError";
  }
}

export function canTransitionRun(currentState: RunState, nextState: RunState): boolean {
  const nextStates: readonly RunState[] = allowedTransitions[currentState];

  return nextStates.includes(nextState);
}

export function transitionRun(run: Run, nextState: RunState, now = new Date()): Run {
  if (!canTransitionRun(run.state, nextState)) {
    throw new InvalidRunStateTransitionError(run.state, nextState);
  }

  return {
    ...run,
    state: nextState,
    // Remember the phase we paused from so a `prompted` event can resume it,
    // and clear it once we leave `awaiting_input`.
    pausedFrom: nextState === "awaiting_input" ? run.state : undefined,
    updatedAt: now,
    completedAt: nextState === "completed" ? now : run.completedAt,
  };
}

// Resume a paused run back into the phase it was working on before it asked a
// human for input.
export function resumeRun(run: Run, now = new Date()): Run {
  if (run.state !== "awaiting_input") {
    throw new InvalidRunStateTransitionError(run.state, run.state);
  }

  if (!run.pausedFrom) {
    throw new Error(`Run ${run.id} is awaiting input but has no phase to resume`);
  }

  return transitionRun(run, run.pausedFrom, now);
}
