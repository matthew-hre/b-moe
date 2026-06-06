import { randomUUID } from "node:crypto";
import { RunSchema, type Run, type RunState, transitionRun } from "../models/run";

export interface CreateRunInput {
  readonly id?: string;
  readonly agentSessionId: string;
  readonly linearIssueId?: string;
}

export interface RunStore {
  createRun(input: CreateRunInput): Promise<Run>;
  getRun(id: string): Promise<Run | undefined>;
  getRunByAgentSession(agentSessionId: string): Promise<Run | undefined>;
  listRuns(): Promise<Run[]>;
  saveRun(run: Run): Promise<Run>;
  transitionRun(id: string, nextState: RunState): Promise<Run>;
}

export class RunAlreadyExistsError extends Error {
  constructor(readonly runId: string) {
    super(`Run already exists: ${runId}`);
    this.name = "RunAlreadyExistsError";
  }
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export type CreateRunId = () => string;
export type GetCurrentDate = () => Date;

export interface InMemoryRunStoreDependencies {
  readonly createRunId?: CreateRunId;
  readonly getCurrentDate?: GetCurrentDate;
}

// Phase 1 store: keep this implementation in-memory while the API and workers settle.
// Phase 2 should add a Redis-backed RunStore behind this same interface.
export class InMemoryRunStore implements RunStore {
  private readonly createRunId: CreateRunId;
  private readonly getCurrentDate: GetCurrentDate;
  private readonly runs = new Map<string, Run>();

  constructor({
    createRunId = randomUUID,
    getCurrentDate = () => new Date(),
  }: InMemoryRunStoreDependencies = {}) {
    this.createRunId = createRunId;
    this.getCurrentDate = getCurrentDate;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const now = this.getCurrentDate();
    const run = RunSchema.parse({
      id: input.id ?? this.createRunId(),
      agentSessionId: input.agentSessionId,
      linearIssueId: input.linearIssueId,
      state: "queued",
      createdAt: now,
      updatedAt: now,
    });

    if (this.runs.has(run.id)) {
      throw new RunAlreadyExistsError(run.id);
    }

    this.runs.set(run.id, run);

    return run;
  }

  async getRun(id: string): Promise<Run | undefined> {
    const run = this.runs.get(id);

    if (!run) {
      return undefined;
    }

    return RunSchema.parse(run);
  }

  async getRunByAgentSession(agentSessionId: string): Promise<Run | undefined> {
    for (const run of this.runs.values()) {
      if (run.agentSessionId === agentSessionId) {
        return RunSchema.parse(run);
      }
    }

    return undefined;
  }

  async listRuns(): Promise<Run[]> {
    return Array.from(this.runs.values(), (run) => RunSchema.parse(run));
  }

  async saveRun(run: Run): Promise<Run> {
    const parsedRun = RunSchema.parse(run);

    this.runs.set(parsedRun.id, parsedRun);

    return parsedRun;
  }

  async transitionRun(id: string, nextState: RunState): Promise<Run> {
    const run = await this.getRun(id);

    if (!run) {
      throw new RunNotFoundError(id);
    }

    const nextRun = transitionRun(run, nextState, this.getCurrentDate());

    return this.saveRun(nextRun);
  }
}
