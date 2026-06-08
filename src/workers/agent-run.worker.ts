import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { AGENT_RUN_QUEUE_NAME, type AgentRunJobData } from "../queue/queue";
import type { Run } from "../models/run";
import type { LinearAgentClient } from "../services/linear.service";
import type { SandboxClient, SandboxSession } from "../services/sandbox.service";
import type { PiClient } from "../services/pi.service";
import type { GitClient } from "../services/git.service";
import type { GitHubClient } from "../services/github.service";
import type { RedisClient } from "../store/redis";
import type { RunStore } from "../store/run.store";

export interface AgentRunWorkerDependencies {
  readonly linearService: LinearAgentClient;
  readonly sandboxService: SandboxClient;
  readonly piService: PiClient;
  readonly gitService: GitClient;
  readonly githubService: GitHubClient;
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
  { linearService, sandboxService, piService, gitService, githubService, runStore }: AgentRunWorkerDependencies,
): Promise<void> {
  const run = await runStore.getRun(runId);

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (
    run.state !== "queued" &&
    run.state !== "refining" &&
    run.state !== "acting"
  ) {
    console.log(`[agent-run-worker] run id=${runId} is ${run.state}; skipping`);
    return;
  }

  if (!run.repositorySelectionQuestion) {
    sandboxService.startProvisioning(run);
  }

  if (run.state === "queued" && run.repositorySelectionQuestion) {
    await linearService.emitActivity(run.agentSessionId, {
      type: "elicitation",
      body: run.repositorySelectionQuestion,
    });
    await runStore.transitionRun(run.id, "refining");
    await runStore.transitionRun(run.id, "awaiting_input");
    return;
  }

  if (run.state === "acting") {
    await processActing(run, { linearService, sandboxService, piService, gitService, githubService, runStore });
    return;
  }

  const refiningRun = run.state === "refining" ? run : await runStore.transitionRun(run.id, "refining");

  await linearService.emitActivity(refiningRun.agentSessionId, {
    type: "thought",
    body: "Starting repository research and implementation in Pi.",
  });

  const actingRun = await runStore.transitionRun(refiningRun.id, "acting");
  await processActing(actingRun, { linearService, sandboxService, piService, gitService, githubService, runStore });
}

export function isPlanApproval(promptBody: string | undefined): boolean {
  if (!promptBody) {
    return false;
  }

  return /\b(approve|approved|looks good|lgtm|go for it|ship it|yes)\b/i.test(promptBody);
}

async function processActing(
  run: Run,
  { linearService, sandboxService, piService, gitService, githubService, runStore }: Pick<AgentRunWorkerDependencies, "linearService" | "sandboxService" | "piService" | "gitService" | "githubService" | "runStore">,
): Promise<void> {
  console.log(`[agent-run-worker] acting start runId=${run.id} repoUrl=${run.repoUrl ?? "unset"}`);

  let sandbox: SandboxSession | undefined;
  let shouldDestroySandbox = true;

  try {
    sandbox = await runStep(run.id, "ensure sandbox", () => sandboxService.ensureSession(run));
    const result = await runStep(run.id, "run Pi", () => piService.act({
      run,
      sandbox,
      onThought: (thought) => linearService.emitActivity(run.agentSessionId, { type: "thought", body: thought }),
      onProgress: (message: string) => linearService.emitActivity(run.agentSessionId, { type: "thought", body: message }),
    }));
    const piRun = result.sessionId && result.sessionId !== run.piSessionId
      ? await runStore.saveRun({ ...run, piSessionId: result.sessionId })
      : run;

    if (result.kind === "needs_input") {
      const pausedRun = await runStore.saveRun({
        ...piRun,
        executionContext: result.context ?? run.executionContext,
        latestPromptBody: undefined,
      });
      await linearService.emitActivity(run.agentSessionId, {
        type: "elicitation",
        body: run.requesterUrl ? `${run.requesterUrl} ${result.question}` : result.question,
      });
      await runStore.transitionRun(pausedRun.id, "awaiting_input");
      shouldDestroySandbox = false;
      return;
    }

    const gitSummary = await runStep(run.id, "describe git head", () => gitService.describeHead({
      sandbox,
      baseBranch: run.baseBranch,
    }));
    console.log(`[agent-run-worker] git summary runId=${run.id}: ${gitSummary}`);
    await runStep(run.id, "commit pending changes", () => gitService.commitAll({
      sandbox,
      message: run.linearIssueId ? `${run.linearIssueId}: B-MOE changes` : "B-MOE changes",
    }));
    await linearService.emitActivity(run.agentSessionId, {
      type: "thought",
      body: "Committed any pending workspace changes.",
    });
    const hasChanges = await runStep(run.id, "check git changes", () => gitService.hasChanges({
      sandbox,
      baseBranch: run.baseBranch,
    }));

    if (!hasChanges) {
      await linearService.emitActivity(run.agentSessionId, {
        type: "response",
        body: `${result.summary}\n\nPi completed but did not produce any git changes, so I'm not opening a PR yet.`,
      });
      await runStore.transitionRun(run.id, "completed");
      return;
    }

    await runStep(run.id, "push branch", () => gitService.pushBranch({
      sandbox,
      branchName: sandbox.branchName,
      repoUrl: run.repoUrl,
    }));
    await linearService.emitActivity(run.agentSessionId, {
      type: "thought",
      body: `Pushed branch \`${sandbox.branchName}\`.`,
    });
    const pullRequest = await runStep(run.id, "create pull request", () => githubService.createPullRequest({
      run,
      repoUrl: run.repoUrl ?? "",
      branchName: sandbox.branchName,
      baseBranch: run.baseBranch,
      summary: result.summary,
    }));
    const prOpenedRun = await runStore.transitionRun(run.id, "pr_opened");
    await runStore.saveRun({ ...prOpenedRun, pullRequest });
    await runStep(run.id, "add PR URL to Linear", () => linearService.addPullRequestUrl(run.agentSessionId, {
      label: "Pull request",
      url: pullRequest.url,
    }));
    await linearService.emitActivity(run.agentSessionId, {
      type: "response",
      body: `${result.summary}\n\nOpened PR: ${pullRequest.url}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitImplementationError(linearService, runStore, run, message);
    throw error;
  } finally {
    if (shouldDestroySandbox && sandbox) {
      await runStep(run.id, "destroy sandbox", () => sandboxService.destroySession(sandbox));
    }
  }
}

async function emitImplementationError(
  linearService: LinearAgentClient,
  runStore: RunStore,
  run: Run,
  message: string,
): Promise<void> {
  try {
    await linearService.emitActivity(run.agentSessionId, {
      type: "error",
      body: message,
      error: message,
    });
  } catch (activityError) {
    const activityMessage = activityError instanceof Error ? activityError.message : String(activityError);
    console.log(`[agent-run-worker] failed to emit error activity runId=${run.id}: ${activityMessage}`);
  }

  const latestRun = await runStore.getRun(run.id);

  if (latestRun && latestRun.state === "acting") {
    await runStore.transitionRun(run.id, "completed");
  }
}

async function runStep<T>(runId: string, step: string, action: () => Promise<T>): Promise<T> {
  console.log(`[agent-run-worker] ${step} start runId=${runId}`);

  try {
    const result = await action();
    console.log(`[agent-run-worker] ${step} done runId=${runId}`);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[agent-run-worker] ${step} failed runId=${runId}: ${message}`);
    throw new Error(`${step} failed: ${message}`, { cause: error });
  }
}
