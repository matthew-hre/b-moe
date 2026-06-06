import { asClass, createContainer, type AwilixContainer } from "awilix";
import { InMemoryRunStore, type RunStore } from "../store/run.store";

export interface Cradle {
  readonly runStore: RunStore;
}

export function createDiContainer(): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>();

  container.register({
    runStore: asClass(InMemoryRunStore).singleton(),
  });

  return container;
}
