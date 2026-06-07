import type { Run } from "../models/run";
import type { SandboxSession } from "./sandbox.service";

export interface PiActResult {
  readonly summary: string;
}

export interface PiClient {
  act(input: { run: Run; sandbox: SandboxSession }): Promise<PiActResult>;
}

export class PiService implements PiClient {
  async act({ run, sandbox }: { run: Run; sandbox: SandboxSession }): Promise<PiActResult> {
    return {
      summary: `Pi acting stub prepared run ${run.id} in ${sandbox.workingDirectory}`,
    };
  }
}
