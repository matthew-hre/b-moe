import { canTransitionRun, resumeRun, type Run } from "../models/run";
import { createLogger } from "../logger";
import type { getAgentSessionTrigger } from "../models/linear";
import type { LinearAgentClient } from "./linear.service";
import type { RunStore } from "../store/run.store";
import type { AgentRunQueue } from "../queue/queue";
import { isPlanApproval } from "../workers/agent-run.worker";
import type { RepositoryClient } from "./repository.service";
import type { SandboxClient } from "./sandbox.service";
import type { PiClient } from "./pi.service";
import type { SteeringStore } from "../store/steering.store";

const logger = createLogger("agent-session-trigger");

export interface AgentSessionTriggerResponse {
  readonly run?: Run;
  readonly ignored?: boolean;
}

export interface AgentSessionTriggerServiceDependencies {
  readonly linearService: LinearAgentClient;
  readonly runStore: RunStore;
  readonly agentRunQueue: AgentRunQueue;
  readonly repositoryService: RepositoryClient;
  readonly sandboxService: SandboxClient;
  readonly piService: PiClient;
  readonly steeringStore: SteeringStore;
}

export class AgentSessionTriggerService {
  private readonly linearService: LinearAgentClient;
  private readonly runStore: RunStore;
  private readonly agentRunQueue: AgentRunQueue;
  private readonly repositoryService: RepositoryClient;
  private readonly sandboxService: SandboxClient;
  private readonly piService: PiClient;
  private readonly steeringStore: SteeringStore;

  constructor({ linearService, runStore, agentRunQueue, repositoryService, sandboxService, piService, steeringStore }: AgentSessionTriggerServiceDependencies) {
    this.linearService = linearService;
    this.runStore = runStore;
    this.agentRunQueue = agentRunQueue;
    this.repositoryService = repositoryService;
    this.sandboxService = sandboxService;
    this.piService = piService;
    this.steeringStore = steeringStore;
  }

  async handle(
    trigger: ReturnType<typeof getAgentSessionTrigger>,
  ): Promise<AgentSessionTriggerResponse> {
    if (!trigger) {
      logger.info("trigger is null; ignoring");
      return { ignored: true };
    }

    logger.info(
      `handling action=${trigger.action} agentSessionId=${trigger.agentSessionId} issueId=${trigger.linearIssueId ?? "none"} stopRequested=${trigger.stopRequested}`,
    );

    if (trigger.stopRequested) {
      return this.handleStop(trigger);
    }

    if (trigger.action === "created") {
      return this.handleCreated(trigger);
    }

    if (trigger.action === "prompted") {
      return this.handlePrompted(trigger);
    }

    logger.warn(`unknown action=${trigger.action}; ignoring`);
    return { ignored: true };
  }

  private async handleStop(
    trigger: ReturnType<typeof getAgentSessionTrigger>,
  ): Promise<AgentSessionTriggerResponse> {
    if (!trigger) {
      throw new Error("handleStop called with null trigger");
    }

    const run = await this.runStore.getRunByAgentSession(trigger.agentSessionId);

    if (!run) {
      logger.info(
        `stop ignored; no run for agentSessionId=${trigger.agentSessionId}`,
      );
      return { ignored: true };
    }

    if (run.state === "completed") {
      return { run };
    }

    await this.sandboxService.destroyRunSandbox(run).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`failed to destroy sandbox for run id=${run.id}: ${message}`);
    });

    const completedRun = canStopRun(run)
      ? await this.runStore.transitionRun(run.id, "completed")
      : run;

    await this.linearService.emitActivity(trigger.agentSessionId, {
      type: "response",
      body: "Stopped — I won't continue this run.",
    });

    return { run: completedRun };
  }

  private async handleCreated(
    trigger: ReturnType<typeof getAgentSessionTrigger>,
  ): Promise<AgentSessionTriggerResponse> {
    if (!trigger || trigger.action !== "created") {
      throw new Error("handleCreated called with non-created trigger");
    }

    const existingRun = await this.runStore.getRunByAgentSession(trigger.agentSessionId);

    if (existingRun) {
      logger.info(
        `existing run found for agentSessionId=${trigger.agentSessionId}`,
      );
      return { run: existingRun };
    }

    const repositoryResolution = this.repositoryService.resolve(trigger.promptContext);
    const run = await this.runStore.createRun({
      agentSessionId: trigger.agentSessionId,
      linearIssueId: trigger.linearIssueId,
      requesterUrl: trigger.requesterUrl,
      requesterName: trigger.requesterName,
      promptContext: trigger.promptContext,
      repoUrl: repositoryResolution.kind === "resolved" ? repositoryResolution.repository.url : undefined,
      baseBranch: repositoryResolution.kind === "resolved" ? repositoryResolution.repository.baseBranch : undefined,
      repositorySelectionQuestion: repositoryResolution.kind === "needs_input" ? repositoryResolution.question : undefined,
    });

    logger.info(`created run id=${run.id}; emitting greeting thought`);
    await this.linearService.emitActivity(trigger.agentSessionId, {
      type: "thought",
      body: "Hi, I'm B-MOE!",
    });
    logger.info(
      `emitted greeting thought for agentSessionId=${trigger.agentSessionId}`,
    );

    this.sandboxService.startProvisioning(run);
    await this.agentRunQueue.enqueueRun(run.id);
    logger.info(`enqueued run id=${run.id}`);

    return { run };
  }

  private async handlePrompted(
    trigger: ReturnType<typeof getAgentSessionTrigger>,
  ): Promise<AgentSessionTriggerResponse> {
    if (!trigger || trigger.action !== "prompted") {
      throw new Error("handlePrompted called with non-prompted trigger");
    }

    const run = await this.runStore.getRunByAgentSession(trigger.agentSessionId);

    if (!run) {
      logger.info(
        `prompted webhook ignored; no run for agentSessionId=${trigger.agentSessionId}`,
      );
      return { ignored: true };
    }

    if (run.state !== "awaiting_input") {
      if (!canSteerRun(run)) {
        await this.linearService.emitActivity(trigger.agentSessionId, {
          type: "response",
          body: "I already finished the Pi implementation loop for this run, so I can't steer it from here.",
        });
        return { run };
      }

      logger.info(
        `prompted webhook recorded as steering; run id=${run.id} state=${run.state}`,
      );
      if (trigger.promptBody?.trim()) {
        const delivered = await this.piService.steer({
          runId: run.id,
          message: trigger.promptBody,
        });

        if (!delivered) {
          await this.steeringStore.enqueue({
            runId: run.id,
            body: trigger.promptBody,
          });
        }

        await this.linearService.emitActivity(trigger.agentSessionId, {
          type: "thought",
          body: delivered
            ? "Got it — I queued that guidance into the active Pi session."
            : "Got it — I queued that guidance for the Pi session.",
        });
      }
      return { run };
    }

    const resumedRun = run.state === "awaiting_input" ? resumeRun(run) : run;
    const repositoryResolution = run.repositorySelectionQuestion
      ? this.repositoryService.resolve(trigger.promptBody)
      : undefined;
    const updatedRun = await this.runStore.saveRun({
      ...resumedRun,
      latestPromptBody: trigger.promptBody,
      repoUrl:
        repositoryResolution?.kind === "resolved" ? repositoryResolution.repository.url : resumedRun.repoUrl,
      baseBranch:
        repositoryResolution?.kind === "resolved"
          ? repositoryResolution.repository.baseBranch
          : resumedRun.baseBranch,
      repositorySelectionQuestion:
        repositoryResolution?.kind === "resolved"
          ? undefined
          : (repositoryResolution?.question ?? resumedRun.repositorySelectionQuestion),
    });

    logger.info(`prompted run id=${updatedRun.id}; emitting response`);
    await this.linearService.emitActivity(trigger.agentSessionId, {
      type: "response",
      body: getPromptedResponseBody(trigger.promptBody, repositoryResolution?.kind),
    });
    logger.info(
      `emitted greeting response for agentSessionId=${trigger.agentSessionId}`,
    );

    if (!updatedRun.repositorySelectionQuestion) {
      this.sandboxService.startProvisioning(updatedRun);
    }

    await this.agentRunQueue.enqueueRun(updatedRun.id);
    logger.info(`enqueued prompted run id=${updatedRun.id}`);

    return { run: updatedRun };
  }
}

function canStopRun(run: Run): boolean {
  return canTransitionRun(run.state, "completed");
}

function canSteerRun(run: Run): boolean {
  return run.state === "queued" || run.state === "refining" || run.state === "acting";
}

function getPromptedResponseBody(
  promptBody: string | undefined,
  repositoryResolutionKind?: "resolved" | "needs_input",
): string {
  if (repositoryResolutionKind === "resolved") {
    return "Got it — I’ll use that repository.";
  }

  if (repositoryResolutionKind === "needs_input") {
    return "I still need a repository before I can continue.";
  }

  if (isPlanApproval(promptBody)) {
    return "Got it — I’ll continue implementation.";
  }

  if (promptBody?.trim()) {
    return "Got it — I’ll continue with that context.";
  }

  return "Got it — I’ll continue.";
}
