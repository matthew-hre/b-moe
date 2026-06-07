import { resumeRun, type Run } from "../models/run";
import type { getAgentSessionTrigger } from "../models/linear";
import type { LinearAgentClient } from "./linear.service";
import type { RunStore } from "../store/run.store";
import type { AgentRunQueue } from "../queue/queue";
import { isPlanApproval } from "../workers/agent-run.worker";

export interface AgentSessionTriggerResponse {
  readonly run?: Run;
  readonly ignored?: boolean;
}

export interface AgentSessionTriggerServiceDependencies {
  readonly linearService: LinearAgentClient;
  readonly runStore: RunStore;
  readonly agentRunQueue: AgentRunQueue;
}

export class AgentSessionTriggerService {
  private readonly linearService: LinearAgentClient;
  private readonly runStore: RunStore;
  private readonly agentRunQueue: AgentRunQueue;

  constructor({ linearService, runStore, agentRunQueue }: AgentSessionTriggerServiceDependencies) {
    this.linearService = linearService;
    this.runStore = runStore;
    this.agentRunQueue = agentRunQueue;
  }

  async handle(
    trigger: ReturnType<typeof getAgentSessionTrigger>,
  ): Promise<AgentSessionTriggerResponse> {
    if (!trigger) {
      console.log("[agent-session-trigger] trigger is null; ignoring");
      return { ignored: true };
    }

    console.log(
      `[agent-session-trigger] handling action=${trigger.action} agentSessionId=${trigger.agentSessionId} issueId=${trigger.linearIssueId ?? "none"}`,
    );

    if (trigger.action === "created") {
      return this.handleCreated(trigger);
    }

    if (trigger.action === "prompted") {
      return this.handlePrompted(trigger);
    }

    console.log(`[agent-session-trigger] unknown action=${trigger.action}; ignoring`);
    return { ignored: true };
  }

  private async handleCreated(
    trigger: ReturnType<typeof getAgentSessionTrigger>,
  ): Promise<AgentSessionTriggerResponse> {
    if (!trigger || trigger.action !== "created") {
      throw new Error("handleCreated called with non-created trigger");
    }

    const existingRun = await this.runStore.getRunByAgentSession(trigger.agentSessionId);

    if (existingRun) {
      console.log(
        `[agent-session-trigger] existing run found for agentSessionId=${trigger.agentSessionId}`,
      );
      return { run: existingRun };
    }

    const run = await this.runStore.createRun({
      agentSessionId: trigger.agentSessionId,
      linearIssueId: trigger.linearIssueId,
      requesterUrl: trigger.requesterUrl,
      requesterName: trigger.requesterName,
      promptContext: trigger.promptContext,
    });

    console.log(`[agent-session-trigger] created run id=${run.id}; emitting greeting thought`);
    await this.linearService.emitActivity(trigger.agentSessionId, {
      type: "thought",
      body: "Hi, I'm B-MOE!",
    });
    console.log(
      `[agent-session-trigger] emitted greeting thought for agentSessionId=${trigger.agentSessionId}`,
    );

    await this.agentRunQueue.enqueueRun(run.id);
    console.log(`[agent-session-trigger] enqueued run id=${run.id}`);

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
      console.log(
        `[agent-session-trigger] prompted webhook ignored; no run for agentSessionId=${trigger.agentSessionId}`,
      );
      return { ignored: true };
    }

    const updatedRun =
      run.state === "awaiting_input"
        ? await this.runStore.saveRun({ ...resumeRun(run), latestPromptBody: trigger.promptBody })
        : await this.runStore.saveRun({ ...run, latestPromptBody: trigger.promptBody });

    console.log(`[agent-session-trigger] prompted run id=${updatedRun.id}; emitting response`);
    await this.linearService.emitActivity(trigger.agentSessionId, {
      type: "response",
      body: getPromptedResponseBody(trigger.promptBody),
    });
    console.log(
      `[agent-session-trigger] emitted greeting response for agentSessionId=${trigger.agentSessionId}`,
    );

    await this.agentRunQueue.enqueueRun(updatedRun.id);
    console.log(`[agent-session-trigger] enqueued prompted run id=${updatedRun.id}`);

    return { run: updatedRun };
  }
}

function getPromptedResponseBody(promptBody: string | undefined): string {
  if (isPlanApproval(promptBody)) {
    return "Approved — I’ll start implementation.";
  }

  if (promptBody?.trim()) {
    return "Got it — I’ll revise the plan around that.";
  }

  return "Got it — I’ll continue.";
}
