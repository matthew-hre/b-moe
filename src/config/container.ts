import { randomUUID } from "node:crypto";
import { asClass, asFunction, asValue, createContainer, type AwilixContainer } from "awilix";
import { LinearClient } from "@linear/sdk";
import { generateText } from "ai";
import { loadEnv, type Env } from "./env";
import { LinearOAuthService, type LinearOAuthClient } from "../services/linear-oauth.service";
import { LinearService, type LinearAgentClient } from "../services/linear.service";
import { LlmService, type LlmClient } from "../services/llm.service";
import { AgentSessionTriggerService } from "../services/agent-session-trigger.service";
import { SandboxService, type SandboxClient } from "../services/sandbox.service";
import { RepositoryService, type RepositoryClient } from "../services/repository.service";
import { PiService, type PiClient } from "../services/pi.service";
import { GitService, type GitClient } from "../services/git.service";
import { GitHubService, type GitHubClient } from "../services/github.service";
import { CommitGenService, type CommitGenClient } from "../services/commit-gen.service";
import { BullMqAgentRunQueue, type AgentRunQueue } from "../queue/queue";
import { AgentRunWorker } from "../workers/agent-run.worker";
import { RedisRunStore, type RunStore } from "../store/run.store";
import {
  RedisLinearInstallStore,
  type LinearInstallStore,
} from "../store/linear-install.store";
import { RedisSteeringStore, type SteeringStore } from "../store/steering.store";
import { createRedisClient, type RedisClient } from "../store/redis";

export interface Cradle {
  readonly env: Env;
  readonly linearOAuthService: LinearOAuthClient;
  readonly linearService: LinearAgentClient;
  readonly llmService: LlmClient;
  readonly repositoryService: RepositoryClient;
  readonly sandboxService: SandboxClient;
  readonly piService: PiClient;
  readonly gitService: GitClient;
  readonly githubService: GitHubClient;
  readonly commitGenService: CommitGenClient;
  readonly agentSessionTriggerService: AgentSessionTriggerService;
  readonly agentRunWorker: AgentRunWorker;
  readonly agentRunQueue: AgentRunQueue;
  readonly runStore: RunStore;
  readonly steeringStore: SteeringStore;
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
    steeringStore: asClass(RedisSteeringStore)
      .singleton()
      .inject(() => ({ createMessageId: randomUUID, getCurrentDate: () => new Date() })),
    agentRunQueue: asFunction(({ redisClient }) => new BullMqAgentRunQueue(redisClient)).singleton(),
    agentRunWorker: asClass(AgentRunWorker).singleton(),
    llmService: asClass(LlmService)
      .singleton()
      .inject(() => ({ createModel: undefined, generateTextFn: generateText })),
    repositoryService: asClass(RepositoryService).singleton(),
    sandboxService: asClass(SandboxService)
      .singleton()
      .inject(() => ({ dockerEngine: undefined })),
    piService: asClass(PiService)
      .singleton()
      .inject(() => ({ rpcRunner: undefined })),
    commitGenService: asClass(CommitGenService).singleton(),
    gitService: asClass(GitService).singleton(),
    githubService: asClass(GitHubService)
      .singleton()
      .inject(() => ({ fetch: globalThis.fetch, now: () => Date.now(), signJwtFn: undefined })),
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
