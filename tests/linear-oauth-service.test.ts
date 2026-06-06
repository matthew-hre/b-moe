import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/config/env";
import {
  LinearOAuthExchangeError,
  LinearOAuthService,
  MissingLinearOAuthConfigError,
} from "../src/services/linear-oauth.service";
import { InMemoryLinearInstallStore } from "../src/store/linear-install.store";

describe("LinearOAuthService", () => {
  test("exchanges OAuth code, fetches app user id, and persists the install", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ input, init });

      if (calls.length === 1) {
        return Response.json({
          access_token: "access-token-1",
          token_type: "Bearer",
          expires_in: 86_399,
          scope: "read write app:assignable app:mentionable",
          refresh_token: "refresh-token-1",
        });
      }

      return Response.json({
        data: {
          viewer: {
            id: "linear-app-user-1",
          },
        },
      });
    };
    const linearInstallStore = new InMemoryLinearInstallStore();
    const service = new LinearOAuthService({
      env: loadEnv({
        LINEAR_CLIENT_ID: "client-id-1",
        LINEAR_CLIENT_SECRET: "client-secret-1",
      }),
      linearInstallStore,
      fetch: mockFetch,
    });

    const install = await service.installFromAuthorizationCode({
      code: "oauth-code-1",
      redirectUri: "https://example.com/oauth/linear/callback",
    });

    expect(install).toEqual({
      linearAppUserId: "linear-app-user-1",
      expiresIn: 86_399,
      scope: "read write app:assignable app:mentionable",
      hasRefreshToken: true,
    });

    const storedInstall = await linearInstallStore.getInstall("linear-app-user-1");
    expect(storedInstall?.appUserId).toBe("linear-app-user-1");
    expect(storedInstall?.accessToken).toBe("access-token-1");
    expect(storedInstall?.refreshToken).toBe("refresh-token-1");
    expect(storedInstall?.scope).toBe("read write app:assignable app:mentionable");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBe("https://api.linear.app/oauth/token");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toEqual(
      new URLSearchParams({
        code: "oauth-code-1",
        redirect_uri: "https://example.com/oauth/linear/callback",
        client_id: "client-id-1",
        client_secret: "client-secret-1",
        grant_type: "authorization_code",
      }),
    );
    expect(calls[1]?.input).toBe("https://api.linear.app/graphql");
    expect(calls[1]?.init?.headers).toEqual({
      Authorization: "Bearer access-token-1",
      "Content-Type": "application/json",
    });
  });

  test("requires OAuth client configuration", async () => {
    const service = new LinearOAuthService({
      env: loadEnv({}),
      linearInstallStore: new InMemoryLinearInstallStore(),
    });

    await expect(
      service.installFromAuthorizationCode({
        code: "oauth-code-1",
        redirectUri: "https://example.com/oauth/linear/callback",
      }),
    ).rejects.toThrow(MissingLinearOAuthConfigError);
  });

  test("throws when token exchange fails", async () => {
    const service = new LinearOAuthService({
      env: loadEnv({
        LINEAR_CLIENT_ID: "client-id-1",
        LINEAR_CLIENT_SECRET: "client-secret-1",
      }),
      linearInstallStore: new InMemoryLinearInstallStore(),
      fetch: async () => new Response(null, { status: 401 }),
    });

    await expect(
      service.installFromAuthorizationCode({
        code: "oauth-code-1",
        redirectUri: "https://example.com/oauth/linear/callback",
      }),
    ).rejects.toThrow(LinearOAuthExchangeError);
  });
});
