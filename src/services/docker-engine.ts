import Dockerode from "dockerode";
import type { Env } from "../config/env";

export interface ContainerExecOptions {
  readonly workingDirectory?: string;
  readonly stdin?: string;
}

export interface ContainerExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ContainerExecStreamHandlers {
  readonly onStdoutChunk: (chunk: string) => void;
  readonly onStderrChunk?: (chunk: string) => void;
}

export interface DockerEngine {
  createContainer(input: { readonly name: string; readonly image: string; readonly labels?: Record<string, string> }): Promise<string>;
  startContainer(containerId: string): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  exec(containerId: string, command: readonly string[], options?: ContainerExecOptions): Promise<ContainerExecResult>;
  execStream(
    containerId: string,
    command: readonly string[],
    handlers: ContainerExecStreamHandlers,
    options?: ContainerExecOptions,
  ): Promise<ContainerExecResult>;
}

export function createDockerEngine(env: Env): DockerEngine {
  const docker = env.dockerHost === "local" ? new Dockerode() : new Dockerode({ host: env.dockerHost });

  return new DockerodeEngine(docker);
}

class DockerodeEngine implements DockerEngine {
  constructor(private readonly docker: Dockerode) {}

  async createContainer(input: { readonly name: string; readonly image: string; readonly labels?: Record<string, string> }): Promise<string> {
    const container = await this.docker.createContainer({
      name: input.name,
      Image: input.image,
      WorkingDir: "/workspace",
      Labels: input.labels,
      HostConfig: {
        AutoRemove: false,
      },
      Cmd: ["sleep", "infinity"],
    });

    return container.id;
  }

  async startContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.start();
  }

  async removeContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);

    try {
      await container.stop({ t: 5 });
    } catch {
      // Container may already be stopped.
    }

    await container.remove({ force: true, v: true });
  }

  async exec(containerId: string, command: readonly string[], options: ContainerExecOptions = {}): Promise<ContainerExecResult> {
    return this.execStream(containerId, command, {
      onStdoutChunk: () => {},
      onStderrChunk: () => {},
    }, options, { collectStdout: true, collectStderr: true });
  }

  async execStream(
    containerId: string,
    command: readonly string[],
    handlers: ContainerExecStreamHandlers,
    options: ContainerExecOptions = {},
    collection: { readonly collectStdout?: boolean; readonly collectStderr?: boolean } = {
      collectStdout: false,
      collectStderr: false,
    },
  ): Promise<ContainerExecResult> {
    const container = this.docker.getContainer(containerId);
    const execInstance = await container.exec({
      Cmd: [...command],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: Boolean(options.stdin),
      WorkingDir: options.workingDirectory,
    });
    // Non-hijack attach returns HTTP 200 with Docker's multiplexed stream. Hijack
    // mode expects HTTP 101, but docker-modem also handles the response path and
    // treats 101 as an error even when the command succeeded.
    const stream = await execInstance.start({
      hijack: false,
      stdin: Boolean(options.stdin),
    });

    if (options.stdin) {
      stream.write(options.stdin);
      stream.end();
    }

    let stdout = "";
    let stderr = "";

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      this.docker.modem.demuxStream(
        stream,
        {
          write: (chunk: Buffer | string) => {
            const text = chunk.toString();
            if (collection.collectStdout) {
              stdout += text;
            }
            handlers.onStdoutChunk(text);
          },
        },
        {
          write: (chunk: Buffer | string) => {
            const text = chunk.toString();
            if (collection.collectStderr) {
              stderr += text;
            }
            handlers.onStderrChunk?.(text);
          },
        },
      );

      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", reject);
    });

    const exitCode = await waitForExecExitCode(execInstance);

    return {
      stdout,
      stderr,
      exitCode,
    };
  }
}

async function waitForExecExitCode(
  execInstance: { inspect(): Promise<{ ExitCode?: number | null }> },
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspect = await execInstance.inspect();

    if (inspect.ExitCode !== null && inspect.ExitCode !== undefined) {
      return inspect.ExitCode;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const inspect = await execInstance.inspect();

  return inspect.ExitCode ?? 0;
}
