import { Queue, type ConnectionOptions } from "bullmq";
import type { RedisClient } from "../store/redis";

export const AGENT_RUN_QUEUE_NAME = "agent-run";

export interface AgentRunJobData {
  readonly runId: string;
}

export interface AgentRunQueue {
  enqueueRun(runId: string): Promise<void>;
}

export class BullMqAgentRunQueue implements AgentRunQueue {
  private readonly queue: Queue<AgentRunJobData>;

  constructor(redisClient: RedisClient) {
    this.queue = new Queue<AgentRunJobData>(AGENT_RUN_QUEUE_NAME, {
      connection: redisClient as unknown as ConnectionOptions,
    });
  }

  async enqueueRun(runId: string): Promise<void> {
    await this.queue.add(
      "run",
      { runId },
      {
        jobId: runId,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}
