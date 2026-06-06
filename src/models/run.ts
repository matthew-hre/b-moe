import { z } from "zod";

export const runStates = [
  "queued",
  "refining",
  "planning",
  "acting",
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
    linearIssueId: z.string().min(1),
    state: RunStateSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
    pullRequest: PullRequestInfoSchema.optional(),
    completedAt: z.date().optional(),
  })
  .strict();

export type Run = Readonly<z.infer<typeof RunSchema>>;

const allowedTransitions = {
  queued: ["refining"],
  refining: ["planning"],
  planning: ["acting"],
  acting: ["pr_opened"],
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
    updatedAt: now,
    completedAt: nextState === "completed" ? now : run.completedAt,
  };
}
