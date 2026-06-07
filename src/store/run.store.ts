import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RunSchema, type Run, type RunState, transitionRun } from "../models/run";

export interface CreateRunInput {
  readonly id?: string;
  readonly agentSessionId: string;
  readonly linearIssueId?: string;
  readonly requesterUrl?: string;
  readonly requesterName?: string;
  readonly promptContext?: string;
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

export interface RedisRunStoreClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  sadd(key: string, value: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  multi(): RedisRunStoreTransaction;
}

export interface RedisRunStoreTransaction {
  set(key: string, value: string): RedisRunStoreTransaction;
  sadd(key: string, value: string): RedisRunStoreTransaction;
  exec(): Promise<unknown>;
}

export interface RedisRunStoreDependencies {
  readonly redisClient: RedisRunStoreClient;
  readonly createRunId?: CreateRunId;
  readonly getCurrentDate?: GetCurrentDate;
}

const REDIS_RUN_IDS_KEY = "runs";
const REDIS_RUN_KEY_PREFIX = "run:";
const REDIS_RUN_AGENT_SESSION_KEY_PREFIX = "run:agent-session:";

const RedisRunSchema = RunSchema.extend({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

function runKey(id: string): string {
  return `${REDIS_RUN_KEY_PREFIX}${id}`;
}

function agentSessionRunKey(agentSessionId: string): string {
  return `${REDIS_RUN_AGENT_SESSION_KEY_PREFIX}${agentSessionId}`;
}

function serializeRun(run: Run): string {
  return JSON.stringify({
    ...run,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    completedAt: run.completedAt?.toISOString(),
  });
}

function deserializeRun(value: string): Run {
  const parsedRun = RedisRunSchema.parse(JSON.parse(value));

  return RunSchema.parse({
    ...parsedRun,
    createdAt: new Date(parsedRun.createdAt),
    updatedAt: new Date(parsedRun.updatedAt),
    completedAt: parsedRun.completedAt ? new Date(parsedRun.completedAt) : undefined,
  });
}

export class RedisRunStore implements RunStore {
  private readonly redis: RedisRunStoreClient;
  private readonly createRunId: CreateRunId;
  private readonly getCurrentDate: GetCurrentDate;

  constructor({
    redisClient,
    createRunId = randomUUID,
    getCurrentDate = () => new Date(),
  }: RedisRunStoreDependencies) {
    this.redis = redisClient;
    this.createRunId = createRunId;
    this.getCurrentDate = getCurrentDate;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const now = this.getCurrentDate();
    const run = RunSchema.parse({
      id: input.id ?? this.createRunId(),
      agentSessionId: input.agentSessionId,
      linearIssueId: input.linearIssueId,
      requesterUrl: input.requesterUrl,
      requesterName: input.requesterName,
      promptContext: input.promptContext,
      state: "queued",
      createdAt: now,
      updatedAt: now,
    });

    if (await this.getRun(run.id)) {
      throw new RunAlreadyExistsError(run.id);
    }

    await this.persistRun(run);

    return run;
  }

  async getRun(id: string): Promise<Run | undefined> {
    const serializedRun = await this.redis.get(runKey(id));

    return serializedRun ? deserializeRun(serializedRun) : undefined;
  }

  async getRunByAgentSession(agentSessionId: string): Promise<Run | undefined> {
    const runId = await this.redis.get(agentSessionRunKey(agentSessionId));

    return runId ? this.getRun(runId) : undefined;
  }

  async listRuns(): Promise<Run[]> {
    const runIds = await this.redis.smembers(REDIS_RUN_IDS_KEY);
    const runs = await Promise.all(runIds.map((id) => this.getRun(id)));

    return runs.filter((run): run is Run => Boolean(run));
  }

  async saveRun(run: Run): Promise<Run> {
    const parsedRun = RunSchema.parse(run);

    await this.persistRun(parsedRun);

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

  private async persistRun(run: Run): Promise<void> {
    await this.redis
      .multi()
      .set(runKey(run.id), serializeRun(run))
      .set(agentSessionRunKey(run.agentSessionId), run.id)
      .sadd(REDIS_RUN_IDS_KEY, run.id)
      .exec();
  }
}

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
      requesterUrl: input.requesterUrl,
      requesterName: input.requesterName,
      promptContext: input.promptContext,
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
