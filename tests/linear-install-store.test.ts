import { describe, expect, test } from "bun:test";
import {
  RedisLinearInstallStore,
  type RedisStringStore,
  type RedisTransaction,
} from "../src/store/linear-install.store";

class FakeRedisTransaction implements RedisTransaction {
  private readonly writes: Array<{ key: string; value: string }> = [];

  constructor(private readonly values: Map<string, string>) {}

  set(key: string, value: string): RedisTransaction {
    this.writes.push({ key, value });

    return this;
  }

  async exec(): Promise<unknown> {
    for (const write of this.writes) {
      this.values.set(write.key, write.value);
    }

    return [];
  }
}

class FakeRedis implements RedisStringStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.values.set(key, value);

    return "OK";
  }

  multi(): RedisTransaction {
    return new FakeRedisTransaction(this.values);
  }
}

describe("RedisLinearInstallStore", () => {
  test("saves and reads the default Linear install", async () => {
    const store = new RedisLinearInstallStore(new FakeRedis());
    const expiresAt = new Date("2025-01-01T00:00:00.000Z");

    const install = await store.saveInstall({
      appUserId: "linear-app-user-1",
      accessToken: "access-token-1",
      scope: "read write app:assignable app:mentionable",
      expiresAt,
      refreshToken: "refresh-token-1",
    });

    expect(install).toEqual({
      appUserId: "linear-app-user-1",
      accessToken: "access-token-1",
      scope: "read write app:assignable app:mentionable",
      expiresAt,
      refreshToken: "refresh-token-1",
    });
    expect(store.getInstall()).resolves.toEqual(install);
  });

  test("reads a specific Linear install by app user id", async () => {
    const store = new RedisLinearInstallStore(new FakeRedis());
    const firstInstall = await store.saveInstall({
      appUserId: "linear-app-user-1",
      accessToken: "access-token-1",
      scope: "read write",
    });
    const secondInstall = await store.saveInstall({
      appUserId: "linear-app-user-2",
      accessToken: "access-token-2",
      scope: ["read", "write"],
    });

    expect(store.getInstall("linear-app-user-1")).resolves.toEqual(firstInstall);
    expect(store.getInstall("linear-app-user-2")).resolves.toEqual(secondInstall);
  });

  test("returns undefined when no default install exists", async () => {
    const store = new RedisLinearInstallStore(new FakeRedis());

    expect(store.getInstall()).resolves.toBeUndefined();
  });
});
