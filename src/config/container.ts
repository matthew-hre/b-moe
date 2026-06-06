import { randomUUID } from "node:crypto";
import { asClass, asValue, createContainer, type AwilixContainer } from "awilix";
import { loadEnv, type Env } from "./env";
import { LinearOAuthService, type LinearOAuthClient } from "../services/linear-oauth.service";
import { LinearService, type LinearAgentClient } from "../services/linear.service";
import { InMemoryRunStore, type RunStore } from "../store/run.store";
import {
  InMemoryLinearInstallStore,
  type LinearInstallStore,
} from "../store/linear-install.store";

export interface Cradle {
  readonly env: Env;
  readonly linearOAuthService: LinearOAuthClient;
  readonly linearService: LinearAgentClient;
  readonly runStore: RunStore;
  readonly linearInstallStore: LinearInstallStore;
}

// These classes take a single destructured options object that mixes container
// deps (env, stores) with non-container deps (fetch, clock, id generator).
// Awilix's proxy mode resolves every destructured key from the cradle, so we
// use `.inject()` to supply the non-container deps; the rest resolve normally.
export function createDiContainer(env: Env = loadEnv()): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>();

  container.register({
    env: asValue(env),
    linearInstallStore: asClass(InMemoryLinearInstallStore).singleton(),
    runStore: asClass(InMemoryRunStore)
      .singleton()
      .inject(() => ({ createRunId: randomUUID, getCurrentDate: () => new Date() })),
    linearOAuthService: asClass(LinearOAuthService)
      .singleton()
      .inject(() => ({ fetch: globalThis.fetch })),
    linearService: asClass(LinearService)
      .singleton()
      .inject(() => ({ fetch: globalThis.fetch })),
  });

  return container;
}
