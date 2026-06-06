import { AwilixContainer, createContainer } from "awilix";

export interface Cradle {
  // services go here
}

export function createDiContainer(): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>();

  // container.register({
  //   myService: asClass(MyService).singleton(),
  // });

  return container;
}
