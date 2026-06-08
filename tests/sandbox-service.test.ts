import { describe, expect, test } from "bun:test";
import { resolveSandboxGitIdentity, SandboxService } from "../src/services/sandbox.service";
import { RepositoryService } from "../src/services/repository.service";
import { InMemoryRunStore } from "../src/store/run.store";
import { loadEnv } from "../src/config/env";
import type { ContainerExecStreamHandlers, DockerEngine } from "../src/services/docker-engine";

describe("resolveSandboxGitIdentity", () => {
  test("derives git identity from the bot GitHub username", () => {
    expect(resolveSandboxGitIdentity(loadEnv({
      REDIS_HOST: "localhost",
      BOT_GITHUB_USERNAME: "b-moe-bot",
    }))).toEqual({
      name: "b-moe-bot",
      email: "b-moe-bot@users.noreply.github.com",
    });
  });

  test("falls back to B-MOE defaults", () => {
    expect(resolveSandboxGitIdentity(loadEnv({ REDIS_HOST: "localhost" }))).toEqual({
      name: "B-MOE",
      email: "b-moe@users.noreply.github.com",
    });
  });
});

describe("SandboxService", () => {
  test("starts provisioning a container as soon as a run is assigned", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const dockerEngine = createFakeDockerEngine();
    const service = new SandboxService({
      env: loadEnv({ REDIS_HOST: "localhost", SANDBOX_IMAGE: "b-moe/sandbox:latest" }),
      runStore,
      repositoryService: new RepositoryService({ env: loadEnv({ REDIS_HOST: "localhost" }) }),
      dockerEngine,
    });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      repoUrl: "https://github.com/acme/repo",
      baseBranch: "main",
      linearIssueId: "ENG-123",
    });

    service.startProvisioning(run);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dockerEngine.created).toEqual([
      { name: "b-moe-sandbox-run-1", image: "b-moe/sandbox:latest", labels: { "b-moe.run-id": "run-1" } },
    ]);
    expect(dockerEngine.started).toEqual(["container-run-1"]);
    expect(await runStore.getRun(run.id)).toMatchObject({
      sandbox: {
        containerId: "container-run-1",
        status: "ready",
        workspacePrepared: true,
        branchName: "b-moe/ENG-123",
      },
    });
    expect(dockerEngine.execCommands[0]?.[2]).toContain("git config user.name 'B-MOE'");
    expect(dockerEngine.execCommands[0]?.[2]).toContain("git config user.email 'b-moe@users.noreply.github.com'");
  });

  test("creates the container immediately even when the repository is not known yet", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const dockerEngine = createFakeDockerEngine();
    const service = new SandboxService({
      env: loadEnv({ REDIS_HOST: "localhost" }),
      runStore,
      repositoryService: new RepositoryService({ env: loadEnv({ REDIS_HOST: "localhost" }) }),
      dockerEngine,
    });
    const run = await runStore.createRun({ agentSessionId: "session-1" });

    service.startProvisioning(run);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dockerEngine.created).toHaveLength(1);
    expect(await runStore.getRun(run.id)).toMatchObject({
      sandbox: {
        containerId: "container-run-1",
        status: "provisioning",
        workspacePrepared: false,
      },
    });
  });

  test("ensureSession waits for workspace preparation before acting", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const dockerEngine = createFakeDockerEngine();
    const service = new SandboxService({
      env: loadEnv({ REDIS_HOST: "localhost" }),
      runStore,
      repositoryService: new RepositoryService({ env: loadEnv({ REDIS_HOST: "localhost" }) }),
      dockerEngine,
    });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      repoUrl: "https://github.com/acme/repo",
      linearIssueId: "ENG-123",
    });

    service.startProvisioning(run);
    const session = await service.ensureSession(run);

    expect(session).toEqual({
      id: "sandbox-run-1",
      runId: "run-1",
      containerId: "container-run-1",
      workingDirectory: "/workspace",
      branchName: "b-moe/ENG-123",
    });
  });

  test("clones private GitHub repositories with an authenticated URL", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const dockerEngine = createFakeDockerEngine();
    const service = new SandboxService({
      env: loadEnv({ REDIS_HOST: "localhost" }),
      runStore,
      repositoryService: new RepositoryService({ env: loadEnv({ REDIS_HOST: "localhost" }) }),
      githubService: {
        async getAccessToken() {
          return "ghs_private_clone_token";
        },
        async createPullRequest() {
          throw new Error("unused in clone test");
        },
      },
      dockerEngine,
    });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      repoUrl: "https://github.com/acme/private-repo",
      linearIssueId: "ENG-123",
    });

    service.startProvisioning(run);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dockerEngine.execCommands[0]?.[2]).toContain(
      "git clone --depth 1 'https://x-access-token:ghs_private_clone_token@github.com/acme/private-repo.git'",
    );
  });

  test("destroys the sandbox container recorded on a run", async () => {
    const runStore = new InMemoryRunStore({ createRunId: () => "run-1" });
    const dockerEngine = createFakeDockerEngine();
    const service = new SandboxService({
      env: loadEnv({ REDIS_HOST: "localhost" }),
      runStore,
      repositoryService: new RepositoryService({ env: loadEnv({ REDIS_HOST: "localhost" }) }),
      dockerEngine,
    });
    const run = await runStore.createRun({
      agentSessionId: "session-1",
      repoUrl: "https://github.com/acme/repo",
    });
    await runStore.saveRun({
      ...run,
      sandbox: {
        containerId: "container-run-1",
        status: "ready",
        workspacePrepared: true,
        branchName: "b-moe/run-1",
      },
    });

    await service.destroyRunSandbox(await runStore.getRun(run.id) as NonNullable<Awaited<ReturnType<typeof runStore.getRun>>>);

    expect(dockerEngine.removed).toEqual(["container-run-1"]);
  });
});

function createFakeDockerEngine(): DockerEngine & {
  readonly created: Array<{ name: string; image: string; labels?: Record<string, string> }>;
  readonly started: string[];
  readonly removed: string[];
  readonly execCommands: Array<readonly string[]>;
} {
  const created: Array<{ name: string; image: string; labels?: Record<string, string> }> = [];
  const started: string[] = [];
  const removed: string[] = [];
  const execCommands: Array<readonly string[]> = [];

  return {
    created,
    started,
    removed,
    execCommands,
    async createContainer(input) {
      created.push(input);
      return `container-${input.name.replace("b-moe-sandbox-", "")}`;
    },
    async startContainer(containerId) {
      started.push(containerId);
    },
    async removeContainer(containerId) {
      removed.push(containerId);
    },
    async exec(_containerId, command) {
      execCommands.push(command);

      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async execStream(_containerId, _command, _handlers: ContainerExecStreamHandlers) {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

