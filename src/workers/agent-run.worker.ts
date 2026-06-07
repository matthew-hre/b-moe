import type { LinearAgentClient } from "../services/linear.service";
import type { RunStore } from "../store/run.store";

export interface AgentRunWorkerDependencies {
  readonly linearService: LinearAgentClient;
  readonly runStore: RunStore;
}

export async function processAgentRun(
  runId: string,
  { linearService, runStore }: AgentRunWorkerDependencies,
): Promise<void> {
  const run = await runStore.getRun(runId);

  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (run.state !== "queued") {
    console.log(`[agent-run-worker] run id=${runId} is ${run.state}; skipping`);
    return;
  }

  const refiningRun = await runStore.transitionRun(run.id, "refining");

  await linearService.emitActivity(refiningRun.agentSessionId, {
    type: "thought",
    body: "I’ve started refining the issue and gathering context.",
  });
}
