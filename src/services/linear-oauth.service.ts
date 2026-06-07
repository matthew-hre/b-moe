import { LinearClient } from "@linear/sdk";
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

export interface LinearOAuthServiceDependencies {
  readonly env: Env;
  readonly linearInstallStore: LinearInstallStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly createClient?: (accessToken: string) => LinearClient;
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
  private readonly createClient: (accessToken: string) => LinearClient;

  constructor({
    env,
    linearInstallStore,
    fetch: fetchImplementation = globalThis.fetch,
    createClient = (accessToken) => new LinearClient({ accessToken }),
  }: LinearOAuthServiceDependencies) {
    this.env = env;
    this.linearInstallStore = linearInstallStore;
    this.fetch = fetchImplementation;
    this.createClient = createClient;
  }

  async installFromAuthorizationCode(
    input: InstallFromAuthorizationCodeInput,
  ): Promise<LinearOAuthInstall> {
    const config = this.getRequiredConfig();

    console.log(`[linear-oauth] exchanging authorization code redirectUri=${input.redirectUri}`);

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
      console.log(`[linear-oauth] token exchange failed status=${tokenResponse.status}`);
      throw new LinearOAuthExchangeError("Linear OAuth token exchange failed");
    }

    const token = LinearTokenResponseSchema.parse(await tokenResponse.json());
    console.log(
      `[linear-oauth] token exchange succeeded expiresIn=${token.expires_in} hasRefreshToken=${Boolean(token.refresh_token)} scope=${Array.isArray(token.scope) ? token.scope.join(" ") : token.scope}`,
    );

    const client = this.createClient(token.access_token);
    const viewer = await client.viewer;
    const appUserId = viewer.id;

    console.log(`[linear-oauth] viewer query succeeded appUserId=${appUserId}`);

    await this.linearInstallStore.saveInstall({
      appUserId,
      accessToken: token.access_token,
      scope: token.scope,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      refreshToken: token.refresh_token,
    });

    console.log(`[linear-oauth] install persisted appUserId=${appUserId}`);

    return {
      linearAppUserId: appUserId,
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