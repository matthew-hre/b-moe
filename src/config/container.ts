import { randomUUID } from "node:crypto";
import { asClass, asFunction, asValue, createContainer, type AwilixContainer } from "awilix";
import { LinearClient } from "@linear/sdk";
import { loadEnv, type Env } from "./env";
import { LinearOAuthService, type LinearOAuthClient } from "../services/linear-oauth.service";
import { LinearService, type LinearAgentClient } from "../services/linear.service";
import { AgentSessionTriggerService } from "../services/agent-session-trigger.service";
import { BullMqAgentRunQueue, type AgentRunQueue } from "../queue/queue";
import { RedisRunStore, type RunStore } from "../store/run.store";
import {
  RedisLinearInstallStore,
  type LinearInstallStore,
} from "../store/linear-install.store";
import { createRedisClient, type RedisClient } from "../store/redis";

export interface Cradle {
  readonly env: Env;
  readonly linearOAuthService: LinearOAuthClient;
  readonly linearService: LinearAgentClient;
  readonly agentSessionTriggerService: AgentSessionTriggerService;
  readonly agentRunQueue: AgentRunQueue;
  readonly runStore: RunStore;
  readonly linearInstallStore: LinearInstallStore;
  readonly redisClient: RedisClient;
}

// These classes take a single destructured options object that mixes container
// deps (env, stores) with non-container deps (fetch, clock, id generator).
// Awilix's proxy mode resolves every destructured key from the cradle, so we
// use `.inject()` to supply the non-container deps; the rest resolve normally.
export function createDiContainer(env: Env = loadEnv()): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>();

  container.register({
    env: asValue(env),
    redisClient: asFunction(({ env }) => createRedisClient(env)).singleton(),
    linearInstallStore: asFunction(({ redisClient }) => new RedisLinearInstallStore(redisClient)).singleton(),
    runStore: asClass(RedisRunStore)
      .singleton()
      .inject(() => ({ createRunId: randomUUID, getCurrentDate: () => new Date() })),
    agentRunQueue: asFunction(({ redisClient }) => new BullMqAgentRunQueue(redisClient)).singleton(),
    linearOAuthService: asClass(LinearOAuthService)
      .singleton()
      .inject(() => ({
        fetch: globalThis.fetch,
        createClient: (accessToken: string) => new LinearClient({ accessToken }),
      })),
    linearService: asClass(LinearService)
      .singleton()
      .inject(() => ({
        createClient: (accessToken: string) => new LinearClient({ accessToken }),
      })),
    agentSessionTriggerService: asClass(AgentSessionTriggerService).singleton(),
  });

  return container;
}
