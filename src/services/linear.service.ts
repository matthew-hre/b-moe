import { LinearClient } from "@linear/sdk";
import type { LinearInstallStore } from "../store/linear-install.store";

export type AgentActivityType = "thought" | "action" | "elicitation" | "response" | "error";

export interface AgentActivityContent {
  readonly type: AgentActivityType;
  readonly body?: string;
  readonly action?: string;
  readonly result?: string;
  readonly error?: string;
}

export interface SessionExternalUrl {
  readonly label: string;
  readonly url: string;
}

export interface LinearServiceDependencies {
  readonly linearInstallStore: LinearInstallStore;
  readonly createClient?: (accessToken: string) => LinearClient;
}

export interface LinearAgentClient {
  emitActivity(agentSessionId: string, content: AgentActivityContent): Promise<void>;
  addPullRequestUrl(agentSessionId: string, pullRequest: SessionExternalUrl): Promise<void>;
}

export class LinearNotInstalledError extends Error {
  constructor() {
    super("Linear app is not installed; complete the OAuth flow first");
    this.name = "LinearNotInstalledError";
  }
}

export class LinearApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearApiError";
  }
}

export class LinearService implements LinearAgentClient {
  private readonly linearInstallStore: LinearInstallStore;
  private readonly createClient: (accessToken: string) => LinearClient;

  constructor({ linearInstallStore, createClient = (accessToken) => new LinearClient({ accessToken }) }: LinearServiceDependencies) {
    this.linearInstallStore = linearInstallStore;
    this.createClient = createClient;
  }

  async emitActivity(agentSessionId: string, content: AgentActivityContent): Promise<void> {
    console.log(`[linear-service] emitting activity type=${content.type} agentSessionId=${agentSessionId}`);
    const client = await this.getClient();
    const result = await client.createAgentActivity({
      agentSessionId,
      content,
    });
    if (!result.success) {
      console.log(`[linear-service] agentActivityCreate returned success=false`);
      throw new LinearApiError("agentActivityCreate returned success=false");
    }
    console.log(`[linear-service] emitted activity type=${content.type} agentSessionId=${agentSessionId}`);
  }

  async addPullRequestUrl(
    agentSessionId: string,
    pullRequest: SessionExternalUrl,
  ): Promise<void> {
    const client = await this.getClient();
    const result = await client.agentSessionUpdateExternalUrl(agentSessionId, {
      addedExternalUrls: [pullRequest],
    });
    if (!result.success) {
      throw new LinearApiError("agentSessionUpdateExternalUrl returned success=false");
    }
  }

  private async getClient(): Promise<LinearClient> {
    const install = await this.linearInstallStore.getInstall();

    if (!install) {
      console.log("[linear-service] no Linear install available");
      throw new LinearNotInstalledError();
    }

    console.log(`[linear-service] using install appUserId=${install.appUserId}`);

    return this.createClient(install.accessToken);
  }
}