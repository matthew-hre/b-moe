import { z } from "zod";
import type { Env } from "../config/env";
import type { LinearInstallStore } from "../store/linear-install.store";

const LinearTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.union([z.string(), z.array(z.string())]),
  refresh_token: z.string().min(1).optional(),
});

const LinearViewerResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string().min(1),
    }),
  }),
});

export interface LinearOAuthServiceDependencies {
  readonly env: Env;
  readonly linearInstallStore: LinearInstallStore;
  readonly fetch?: typeof fetch;
}

export interface InstallFromAuthorizationCodeInput {
  readonly code: string;
  readonly redirectUri: string;
}

export interface LinearOAuthInstall {
  readonly linearAppUserId: string;
  readonly expiresIn: number;
  readonly scope: string | string[];
  readonly hasRefreshToken: boolean;
}

export interface LinearOAuthClient {
  installFromAuthorizationCode(input: InstallFromAuthorizationCodeInput): Promise<LinearOAuthInstall>;
}

export class MissingLinearOAuthConfigError extends Error {
  constructor(readonly missingKeys: readonly string[]) {
    super(`Missing Linear OAuth configuration: ${missingKeys.join(", ")}`);
    this.name = "MissingLinearOAuthConfigError";
  }
}

export class LinearOAuthExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearOAuthExchangeError";
  }
}

export class LinearOAuthService implements LinearOAuthClient {
  private readonly env: Env;
  private readonly linearInstallStore: LinearInstallStore;
  private readonly fetch: typeof globalThis.fetch;

  constructor({
    env,
    linearInstallStore,
    fetch: fetchImplementation = globalThis.fetch,
  }: LinearOAuthServiceDependencies) {
    this.env = env;
    this.linearInstallStore = linearInstallStore;
    this.fetch = fetchImplementation;
  }

  async installFromAuthorizationCode(
    input: InstallFromAuthorizationCodeInput,
  ): Promise<LinearOAuthInstall> {
    const config = this.getRequiredConfig();

    const tokenResponse = await this.fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: config.linearClientId,
        client_secret: config.linearClientSecret,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      throw new LinearOAuthExchangeError("Linear OAuth token exchange failed");
    }

    const token = LinearTokenResponseSchema.parse(await tokenResponse.json());
    const viewerResponse = await this.fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "query Viewer { viewer { id } }",
      }),
    });

    if (!viewerResponse.ok) {
      throw new LinearOAuthExchangeError("Linear viewer query failed");
    }

    const viewer = LinearViewerResponseSchema.parse(await viewerResponse.json());

    await this.linearInstallStore.saveInstall({
      appUserId: viewer.data.viewer.id,
      accessToken: token.access_token,
      scope: token.scope,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      refreshToken: token.refresh_token,
    });

    return {
      linearAppUserId: viewer.data.viewer.id,
      expiresIn: token.expires_in,
      scope: token.scope,
      hasRefreshToken: Boolean(token.refresh_token),
    };
  }

  private getRequiredConfig(): { readonly linearClientId: string; readonly linearClientSecret: string } {
    const missingKeys: string[] = [];
    const { linearClientId, linearClientSecret } = this.env;

    if (!linearClientId) {
      missingKeys.push("LINEAR_CLIENT_ID");
    }

    if (!linearClientSecret) {
      missingKeys.push("LINEAR_CLIENT_SECRET");
    }

    if (missingKeys.length > 0) {
      throw new MissingLinearOAuthConfigError(missingKeys);
    }

    return {
      linearClientId: linearClientId as string,
      linearClientSecret: linearClientSecret as string,
    };
  }
}
