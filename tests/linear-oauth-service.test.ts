import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadEnv } from "../src/config/env";
import {
  LinearOAuthExchangeError,
  LinearOAuthService,
  MissingLinearOAuthConfigError,
} from "../src/services/linear-oauth.service";
import { InMemoryLinearInstallStore } from "../src/store/linear-install.store";

describe("LinearOAuthService", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("exchanges OAuth code, fetches app user id, and persists the install", async () => {
    const tokenFetchCalls: Array<{ input: string | Request | URL; init?: RequestInit }> = [];
    const mockTokenFetch = (async (input, init) => {
      tokenFetchCalls.push({ input, init });
      return Response.json({
        access_token: "access-token-1",
        token_type: "Bearer",
        expires_in: 86_399,
        scope: "read write app:assignable app:mentionable",
        refresh_token: "refresh-token-1",
      });
    }) as typeof fetch;

    const viewerFetchCalls: Array<{ input: string; init?: RequestInit }> = [];
    (globalThis.fetch as unknown) = async (input: unknown, init: RequestInit | undefined) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
      viewerFetchCalls.push({ input: url, init });
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
        REDIS_HOST: "localhost",
      }),
      linearInstallStore,
      fetch: mockTokenFetch,
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

    expect(tokenFetchCalls).toHaveLength(1);
    expect(tokenFetchCalls[0]?.input).toBe("https://api.linear.app/oauth/token");
    expect(tokenFetchCalls[0]?.init?.method).toBe("POST");
    expect(tokenFetchCalls[0]?.init?.body).toEqual(
      new URLSearchParams({
        code: "oauth-code-1",
        redirect_uri: "https://example.com/oauth/linear/callback",
        client_id: "client-id-1",
        client_secret: "client-secret-1",
        grant_type: "authorization_code",
      }),
    );

    expect(viewerFetchCalls).toHaveLength(1);
    expect(viewerFetchCalls[0]?.input).toBe("https://api.linear.app/graphql");
    expect((viewerFetchCalls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer access-token-1",
    );
  });

  test("requires OAuth client configuration", async () => {
    const service = new LinearOAuthService({
      env: loadEnv({ REDIS_HOST: "localhost" }),
      linearInstallStore: new InMemoryLinearInstallStore(),
    });

    expect(
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
        REDIS_HOST: "localhost",
      }),
      linearInstallStore: new InMemoryLinearInstallStore(),
      fetch: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
    });

    expect(
      service.installFromAuthorizationCode({
        code: "oauth-code-1",
        redirectUri: "https://example.com/oauth/linear/callback",
      }),
    ).rejects.toThrow(LinearOAuthExchangeError);
  });

  test("refreshes an expired access token before returning the install", async () => {
    const tokenFetchCalls: Array<{ init?: RequestInit }> = [];
    const mockTokenFetch = (async (_input, init) => {
      tokenFetchCalls.push({ init });
      return Response.json({
        access_token: "access-token-2",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write app:assignable app:mentionable",
        refresh_token: "refresh-token-2",
      });
    }) as typeof fetch;

    const linearInstallStore = new InMemoryLinearInstallStore();
    await linearInstallStore.saveInstall({
      appUserId: "linear-app-user-1",
      accessToken: "access-token-1",
      scope: "read write app:assignable app:mentionable",
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
      refreshToken: "refresh-token-1",
    });

    const service = new LinearOAuthService({
      env: loadEnv({
        LINEAR_CLIENT_ID: "client-id-1",
        LINEAR_CLIENT_SECRET: "client-secret-1",
        REDIS_HOST: "localhost",
      }),
      linearInstallStore,
      fetch: mockTokenFetch,
    });

    const install = await service.ensureFreshAccessToken("linear-app-user-1");

    expect(install.accessToken).toBe("access-token-2");
    expect(install.refreshToken).toBe("refresh-token-2");
    expect(tokenFetchCalls).toHaveLength(1);
    expect(tokenFetchCalls[0]?.init?.body).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "refresh-token-1",
        client_id: "client-id-1",
        client_secret: "client-secret-1",
      }),
    );

    const storedInstall = await linearInstallStore.getInstall("linear-app-user-1");
    expect(storedInstall?.accessToken).toBe("access-token-2");
  });

  test("returns a still-valid install without refreshing", async () => {
    const linearInstallStore = new InMemoryLinearInstallStore();
    await linearInstallStore.saveInstall({
      appUserId: "linear-app-user-1",
      accessToken: "access-token-1",
      scope: "read write app:assignable app:mentionable",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      refreshToken: "refresh-token-1",
    });

    const service = new LinearOAuthService({
      env: loadEnv({
        LINEAR_CLIENT_ID: "client-id-1",
        LINEAR_CLIENT_SECRET: "client-secret-1",
        REDIS_HOST: "localhost",
      }),
      linearInstallStore,
      fetch: (async () => {
        throw new Error("refresh should not be called");
      }) as unknown as typeof fetch,
    });

    const install = await service.ensureFreshAccessToken("linear-app-user-1");

    expect(install.accessToken).toBe("access-token-1");
  });
});
