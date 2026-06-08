import { LinearClient } from "@linear/sdk";
import { createLogger } from "../logger";
import type { LinearOAuthClient } from "./linear-oauth.service";

const logger = createLogger("linear-service");

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
  readonly linearOAuthService: LinearOAuthClient;
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
  private readonly linearOAuthService: LinearOAuthClient;
  private readonly createClient: (accessToken: string) => LinearClient;

  constructor({ linearOAuthService, createClient = (accessToken) => new LinearClient({ accessToken }) }: LinearServiceDependencies) {
    this.linearOAuthService = linearOAuthService;
    this.createClient = createClient;
  }

  async emitActivity(agentSessionId: string, content: AgentActivityContent): Promise<void> {
    logger.info(`emitting activity type=${content.type} agentSessionId=${agentSessionId}`);
    const client = await this.getClient();
    const result = await client.createAgentActivity({
      agentSessionId,
      content,
    });
    if (!result.success) {
      logger.warn("agentActivityCreate returned success=false");
      throw new LinearApiError("agentActivityCreate returned success=false");
    }
    logger.info(`emitted activity type=${content.type} agentSessionId=${agentSessionId}`);
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
    let install;

    try {
      install = await this.linearOAuthService.ensureFreshAccessToken();
    } catch (error) {
      if (error instanceof Error && error.message === "Linear app is not installed; complete the OAuth flow first") {
        logger.warn("no Linear install available");
        throw new LinearNotInstalledError();
      }

      throw error;
    }

    logger.info(`using install appUserId=${install.appUserId}`);

    return this.createClient(install.accessToken);
  }
}