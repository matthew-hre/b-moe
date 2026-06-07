import type { Run } from "../models/run";
import type { RepositoryClient } from "./repository.service";

export interface SandboxSession {
  readonly id: string;
  readonly runId: string;
  readonly workingDirectory: string;
}

export interface SandboxClient {
  createSession(run: Run): Promise<SandboxSession>;
  destroySession(session: SandboxSession): Promise<void>;
}

export interface SandboxServiceDependencies {
  readonly repositoryService: RepositoryClient;
}

export class SandboxService implements SandboxClient {
  private readonly repositoryService: RepositoryClient;

  constructor({ repositoryService }: SandboxServiceDependencies) {
    this.repositoryService = repositoryService;
  }

  async createSession(run: Run): Promise<SandboxSession> {
    const workspace = await this.repositoryService.getWorkspace(run);

    return {
      id: `sandbox-${run.id}`,
      runId: run.id,
      workingDirectory: workspace.path,
    };
  }

  async destroySession(_session: SandboxSession): Promise<void> {}
}
