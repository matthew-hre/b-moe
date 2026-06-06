import { describe, expect, test } from "bun:test";
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

describe("LinearService", () => {
  test("emits an agent activity using the stored access token", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ input, init });

      return Response.json({ data: { agentActivityCreate: { success: true } } });
    };
    const service = new LinearService({
      linearInstallStore: await storeWithInstall(),
      fetch: mockFetch,
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
    const mockFetch: typeof fetch = async (_input, init) => {
      calls.push({ init });

      return Response.json({ data: { agentSessionUpdate: { success: true } } });
    };
    const service = new LinearService({
      linearInstallStore: await storeWithInstall(),
      fetch: mockFetch,
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
      fetch: async () => Response.json({ data: {} }),
    });

    await expect(
      service.emitActivity("session-1", { type: "thought", body: "hi" }),
    ).rejects.toThrow(LinearNotInstalledError);
  });

  test("surfaces GraphQL errors", async () => {
    const service = new LinearService({
      linearInstallStore: await storeWithInstall(),
      fetch: async () => Response.json({ errors: [{ message: "boom" }] }),
    });

    await expect(
      service.emitActivity("session-1", { type: "thought", body: "hi" }),
    ).rejects.toThrow("boom");
  });
});
