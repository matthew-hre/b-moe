import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { AGENT_RUN_QUEUE_NAME, type AgentRunJobData } from "../queue/queue";
import type { Run } from "../models/run";
import type { LinearAgentClient } from "../services/linear.service";
import type { PlanningClient } from "../services/planning.service";
import type { RedisClient } from "../store/redis";
import type { RunStore } from "../store/run.store";

export interface AgentRunWorkerDependencies {
  readonly linearService: LinearAgentClient;
  readonly planningService: PlanningClient;
  readonly redisClient: RedisClient;
  readonly runStore: RunStore;
}

export class AgentRunWorker {
  private worker?: Worker<AgentRunJobData>;

  constructor(private readonly dependencies: AgentRunWorkerDependencies) {}

  start(): void {
    if (this.worker) {
      return;
    }

    this.worker = new Worker<AgentRunJobData>(
      AGENT_RUN_QUEUE_NAME,
      (job) => this.processJob(job),
      {
        connection: this.dependencies.redisClient as unknown as ConnectionOptions,
      },
    );

    this.worker.on("completed", (job) => {
      console.log(`[agent-run-worker] completed job id=${job.id ?? "unknown"} runId=${job.data.runId}`);
    });
    this.worker.on("failed", (job, error) => {
      console.log(
        `[agent-run-worker] failed job id=${job?.id ?? "unknown"} runId=${job?.data.runId ?? "unknown"}: ${error.message}`,
      );
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }

  async processJob(job: Pick<Job<AgentRunJobData>, "data">): Promise<void> {
    await processAgentRun(job.data.runId, this.dependencies);
  }
}

export async function processAgentRun(
  runId: string,
  { linearService, planningService, runStore }: AgentRunWorkerDependencies,
): Promise<void> {
  const run = await runStore.getRun(runId);

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (run.state !== "queued" && run.state !== "planning") {
    console.log(`[agent-run-worker] run id=${runId} is ${run.state}; skipping`);
    return;
  }

  if (run.state === "planning") {
    await processPlanReview(run, { linearService, planningService, runStore });
    return;
  }

  const refiningRun = await runStore.transitionRun(run.id, "refining");

  await linearService.emitActivity(refiningRun.agentSessionId, {
    type: "thought",
    body: "I’ve started refining the issue and gathering context.",
  });

  const planningRun = await runStore.transitionRun(refiningRun.id, "planning");
  const plan = await planningService.createPlan(planningRun);
  const plannedRun = await runStore.saveRun({ ...planningRun, plan });
  await requestPlanReview(plannedRun, plan, { linearService, runStore });
}

async function processPlanReview(
  run: Run,
  { linearService, planningService, runStore }: Pick<AgentRunWorkerDependencies, "linearService" | "planningService" | "runStore">,
): Promise<void> {
  if (isPlanApproval(run.latestPromptBody)) {
    await runStore.transitionRun(run.id, "acting");
    await linearService.emitActivity(run.agentSessionId, {
      type: "thought",
      body: "Plan approved. I’m moving into implementation.",
    });
    return;
  }

  const plan = await planningService.createPlan(run);
  const plannedRun = await runStore.saveRun({ ...run, plan, latestPromptBody: undefined });
  await requestPlanReview(plannedRun, plan, { linearService, runStore });
}

async function requestPlanReview(
  run: Run,
  plan: string,
  { linearService, runStore }: Pick<AgentRunWorkerDependencies, "linearService" | "runStore">,
): Promise<void> {
  const responseBody = run.requesterUrl
    ? `${run.requesterUrl} please review this plan:\n\n${plan}`
    : plan;

  await linearService.emitActivity(run.agentSessionId, {
    type: "elicitation",
    body: responseBody,
  });

  await runStore.transitionRun(run.id, "awaiting_input");
}

export function isPlanApproval(promptBody: string | undefined): boolean {
  if (!promptBody) {
    return false;
  }

  return /\b(approve|approved|looks good|lgtm|go for it|ship it|yes)\b/i.test(promptBody);
}
