import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { LinearNotInstalledError, LinearService } from "../src/services/linear.service";
import { InMemoryLinearInstallStore } from "../src/store/linear-install.store";

async function storeWithInstall(): Promise<InMemoryLinearInstallStore> {
  const store = new InMemoryLinearInstallStore();
  await store.saveInstall({
    appUserId: "linear-app-user-1",
    accessToken: "access-token-1",
    scope: "read write app:assignable app:mentionable",
  });

  return store;
}

function mockGraphQLFetch(
  handler: (url: string, init: RequestInit) => unknown,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    const result = handler(url, init as RequestInit);
    if (result instanceof Response) return result;
    return Response.json(result);
  };
}

describe("LinearService", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("emits an agent activity using the stored access token", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = mockGraphQLFetch((url, init) => {
      calls.push({ input: url, init });
      return { data: { agentActivityCreate: { success: true } } };
    });

    const service = new LinearService({
      linearInstallStore: await storeWithInstall(),
    });

    await service.emitActivity("session-1", { type: "thought", body: "Looking into this" });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.input).toBe("https://api.linear.app/graphql");
    expect((call?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer access-token-1",
    );
    const sentBody = JSON.parse(String(call?.init?.body));
    expect(sentBody.variables).toEqual({
      input: { agentSessionId: "session-1", content: { type: "thought", body: "Looking into this" } },
    });
  });

  test("adds a pull request url to the session", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = mockGraphQLFetch((_url, init) => {
      calls.push({ init });
      return { data: { agentSessionUpdateExternalUrl: { success: true } } };
    });

    const service = new LinearService({
      linearInstallStore: await storeWithInstall(),
    });

    await service.addPullRequestUrl("session-1", {
      label: "Pull request",
      url: "https://github.com/acme/repo/pull/1",
    });

    const sentBody = JSON.parse(String(calls[0]?.init?.body));
    expect(sentBody.variables).toEqual({
      id: "session-1",
      input: {
        addedExternalUrls: [
          { label: "Pull request", url: "https://github.com/acme/repo/pull/1" },
        ],
      },
    });
  });

  test("throws when the app is not installed", async () => {
    const service = new LinearService({
      linearInstallStore: new InMemoryLinearInstallStore(),
    });

    expect(
      service.emitActivity("session-1", { type: "thought", body: "hi" }),
    ).rejects.toThrow(LinearNotInstalledError);
  });

  test("surfaces GraphQL errors", async () => {
    globalThis.fetch = mockGraphQLFetch(() => ({
      errors: [{ message: "boom" }],
    }));

    const service = new LinearService({
      linearInstallStore: await storeWithInstall(),
    });

    expect(
      service.emitActivity("session-1", { type: "thought", body: "hi" }),
    ).rejects.toThrow("boom");
  });
});
