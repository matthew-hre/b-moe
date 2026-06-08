import type { Run, RunSandbox } from "../models/run";
import type { RunStore } from "../store/run.store";
import type { Env } from "../config/env";
import type { GitHubClient } from "./github.service";
import {
  createAuthenticatedGitHubUrl,
  createBranchName,
  type RepositoryClient,
} from "./repository.service";
import type { ContainerExecOptions, ContainerExecResult, ContainerExecStreamHandlers, DockerEngine } from "./docker-engine";
import { createDockerEngine } from "./docker-engine";

export const SANDBOX_WORKSPACE_DIR = "/workspace";

export function resolveSandboxGitIdentity(env: Env): { readonly name: string; readonly email: string } {
  const username = env.botGithubUsername ?? "b-moe";

  return {
    name: env.botGithubUsername ?? "B-MOE",
    email: `${username}@users.noreply.github.com`,
  };
}

export interface SandboxSession {
  readonly id: string;
  readonly runId: string;
  readonly containerId: string;
  readonly workingDirectory: string;
  readonly branchName: string;
}

export interface SandboxExecOptions extends ContainerExecOptions {}

export interface SandboxExecResult extends ContainerExecResult {}

export interface SandboxClient {
  startProvisioning(run: Run): void;
  ensureSession(run: Run): Promise<SandboxSession>;
  exec(session: SandboxSession, command: readonly string[], options?: SandboxExecOptions): Promise<SandboxExecResult>;
  execStream(
    session: SandboxSession,
    command: readonly string[],
    handlers: ContainerExecStreamHandlers,
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult>;
  destroySession(session: SandboxSession): Promise<void>;
  destroyRunSandbox(run: Run): Promise<void>;
}

export interface SandboxServiceDependencies {
  readonly env: Env;
  readonly runStore: RunStore;
  readonly repositoryService: RepositoryClient;
  readonly githubService?: GitHubClient;
  readonly dockerEngine?: DockerEngine;
}

export class SandboxService implements SandboxClient {
  private readonly env: Env;
  private readonly runStore: RunStore;
  private readonly repositoryService: RepositoryClient;
  private readonly githubService?: GitHubClient;
  private readonly dockerEngine: DockerEngine;
  private readonly provisioningPromises = new Map<string, Promise<void>>();

  constructor({
    env,
    runStore,
    repositoryService,
    githubService,
    dockerEngine = createDockerEngine(env),
  }: SandboxServiceDependencies) {
    this.env = env;
    this.runStore = runStore;
    this.repositoryService = repositoryService;
    this.githubService = githubService;
    this.dockerEngine = dockerEngine;
  }

  startProvisioning(run: Run): void {
    void this.ensureProvisioning(run.id).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[sandbox-service] provisioning failed runId=${run.id}: ${message}`);
    });
  }

  async ensureSession(run: Run): Promise<SandboxSession> {
    await this.ensureProvisioning(run.id);

    const latestRun = await this.runStore.getRun(run.id);

    if (!latestRun?.sandbox) {
      throw new Error(`Sandbox was not provisioned for run ${run.id}`);
    }

    if (latestRun.sandbox.status === "failed") {
      throw new Error(latestRun.sandbox.error ?? `Sandbox provisioning failed for run ${run.id}`);
    }

    if (!latestRun.repoUrl) {
      throw new Error(`Run ${run.id} has no repository URL`);
    }

    if (!latestRun.sandbox.workspacePrepared) {
      await this.prepareWorkspace(latestRun);
    }

    const readyRun = await this.runStore.getRun(run.id);

    if (!readyRun?.sandbox?.workspacePrepared || !readyRun.sandbox.branchName) {
      throw new Error(`Sandbox workspace is not ready for run ${run.id}`);
    }

    return this.toSession(readyRun, readyRun.sandbox.containerId, readyRun.sandbox.branchName);
  }

  async exec(session: SandboxSession, command: readonly string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    return this.dockerEngine.exec(session.containerId, command, {
      ...options,
      workingDirectory: options.workingDirectory ?? session.workingDirectory,
    });
  }

  async execStream(
    session: SandboxSession,
    command: readonly string[],
    handlers: ContainerExecStreamHandlers,
    options: SandboxExecOptions = {},
  ): Promise<SandboxExecResult> {
    return this.dockerEngine.execStream(session.containerId, command, handlers, {
      ...options,
      workingDirectory: options.workingDirectory ?? session.workingDirectory,
    });
  }

  async destroySession(session: SandboxSession): Promise<void> {
    console.log(`[sandbox-service] destroying sandbox runId=${session.runId} containerId=${session.containerId}`);
    await this.dockerEngine.removeContainer(session.containerId);
    this.provisioningPromises.delete(session.runId);
  }

  async destroyRunSandbox(run: Run): Promise<void> {
    const containerId = run.sandbox?.containerId;

    if (!containerId) {
      return;
    }

    console.log(`[sandbox-service] destroying sandbox for stopped run runId=${run.id} containerId=${containerId}`);
    await this.dockerEngine.removeContainer(containerId);
    this.provisioningPromises.delete(run.id);
  }

  private async ensureProvisioning(runId: string): Promise<void> {
    const existingPromise = this.provisioningPromises.get(runId);

    if (existingPromise) {
      await existingPromise;
      return;
    }

    const promise = this.provisionRun(runId);
    this.provisioningPromises.set(runId, promise);

    try {
      await promise;
    } catch (error) {
      this.provisioningPromises.delete(runId);
      throw error;
    }
  }

  private async provisionRun(runId: string): Promise<void> {
    const run = await this.runStore.getRun(runId);

    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.sandbox?.status === "ready") {
      return;
    }

    if (run.sandbox?.status === "failed") {
      if (!run.sandbox.containerId || !run.repoUrl) {
        throw new Error(run.sandbox.error ?? `Sandbox provisioning failed for run ${runId}`);
      }

      console.log(`[sandbox-service] retrying failed workspace prep runId=${runId}`);
      await this.saveSandboxState(runId, {
        containerId: run.sandbox.containerId,
        status: "provisioning",
        workspacePrepared: false,
      });
      const latestRun = await this.runStore.getRun(runId);

      if (latestRun) {
        await this.prepareWorkspace(latestRun);
      }

      return;
    }

    let containerId = run.sandbox?.containerId;

    if (!containerId) {
      console.log(`[sandbox-service] creating container runId=${runId} image=${this.env.sandboxImage}`);
      containerId = await this.dockerEngine.createContainer({
        name: `b-moe-sandbox-${run.id}`,
        image: this.env.sandboxImage,
        labels: { "b-moe.run-id": run.id },
      });
      await this.dockerEngine.startContainer(containerId);
      await this.saveSandboxState(runId, {
        containerId,
        status: "provisioning",
        workspacePrepared: false,
      });
      console.log(`[sandbox-service] container started runId=${runId} containerId=${containerId}`);
    }

    if (run.repoUrl) {
      const latestRun = await this.runStore.getRun(runId);

      if (latestRun && !latestRun.sandbox?.workspacePrepared) {
        await this.prepareWorkspace(latestRun);
      }
    }
  }

  private async prepareWorkspace(run: Run): Promise<void> {
    if (!run.repoUrl || !run.sandbox?.containerId) {
      return;
    }

    const branchName = createBranchName(run);
    const cloneUrl = await this.getCloneUrl(run.repoUrl);

    console.log(
      `[sandbox-service] preparing workspace runId=${run.id} containerId=${run.sandbox.containerId} repoUrl=${run.repoUrl}`,
    );

    try {
      const baseBranch = run.baseBranch ?? "main";
      const gitIdentity = resolveSandboxGitIdentity(this.env);
      const script = [
        "set -euo pipefail",
        `rm -rf ${SANDBOX_WORKSPACE_DIR}`,
        `mkdir -p ${SANDBOX_WORKSPACE_DIR}`,
        `git clone --depth 1 ${shellQuote(cloneUrl)} ${SANDBOX_WORKSPACE_DIR}`,
        `cd ${SANDBOX_WORKSPACE_DIR}`,
        `git config user.name ${shellQuote(gitIdentity.name)}`,
        `git config user.email ${shellQuote(gitIdentity.email)}`,
        `git checkout ${shellQuote(baseBranch)} 2>/dev/null || true`,
        `git checkout -B ${shellQuote(branchName)}`,
      ].join("\n");
      const result = await this.dockerEngine.exec(run.sandbox.containerId, ["bash", "-ec", script], {
        workingDirectory: "/",
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || `git clone failed with exit code ${result.exitCode}`);
      }

      await this.saveSandboxState(run.id, {
        containerId: run.sandbox.containerId,
        status: "ready",
        workspacePrepared: true,
        branchName,
      });
      console.log(`[sandbox-service] workspace ready runId=${run.id} branch=${branchName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.saveSandboxState(run.id, {
        containerId: run.sandbox.containerId,
        status: "failed",
        workspacePrepared: false,
        error: message,
      });
      throw error;
    }
  }

  private async saveSandboxState(runId: string, sandbox: RunSandbox): Promise<void> {
    const current = await this.runStore.getRun(runId);

    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }

    await this.runStore.saveRun({ ...current, sandbox });
  }

  private async getCloneUrl(repoUrl: string): Promise<string> {
    if (!this.githubService || !isGitHubUrl(repoUrl)) {
      return repoUrl;
    }

    const token = await this.githubService.getAccessToken();

    return createAuthenticatedGitHubUrl(repoUrl, token);
  }

  private toSession(run: Run, containerId: string, branchName: string): SandboxSession {
    return {
      id: `sandbox-${run.id}`,
      runId: run.id,
      containerId,
      workingDirectory: SANDBOX_WORKSPACE_DIR,
      branchName,
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isGitHubUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}
