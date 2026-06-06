import { z } from "zod";
import type { LinearInstallStore } from "../store/linear-install.store";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// The agent activity types Linear accepts. `prompt` is user-generated and
// cannot be emitted by an agent, so it is intentionally absent here.
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

const GraphQLResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(z.object({ message: z.string() }).loose())
    .optional(),
});

export interface LinearServiceDependencies {
  readonly linearInstallStore: LinearInstallStore;
  readonly fetch?: typeof fetch;
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
  private readonly fetch: typeof globalThis.fetch;

  constructor({
    linearInstallStore,
    fetch: fetchImplementation = globalThis.fetch,
  }: LinearServiceDependencies) {
    this.linearInstallStore = linearInstallStore;
    this.fetch = fetchImplementation;
  }

  async emitActivity(agentSessionId: string, content: AgentActivityContent): Promise<void> {
    await this.mutate(
      `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }`,
      { input: { agentSessionId, content } },
    );
  }

  async addPullRequestUrl(
    agentSessionId: string,
    pullRequest: SessionExternalUrl,
  ): Promise<void> {
    await this.mutate(
      `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
        }
      }`,
      { id: agentSessionId, input: { addedExternalUrls: [pullRequest] } },
    );
  }

  private async mutate(query: string, variables: Record<string, unknown>): Promise<void> {
    const install = await this.linearInstallStore.getInstall();

    if (!install) {
      throw new LinearNotInstalledError();
    }

    const response = await this.fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${install.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new LinearApiError(`Linear API request failed with status ${response.status}`);
    }

    const result = GraphQLResponseSchema.parse(await response.json());

    if (result.errors && result.errors.length > 0) {
      throw new LinearApiError(result.errors.map((error) => error.message).join("; "));
    }
  }
}
