import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/config/env";

describe("loadEnv", () => {
  test("loads Linear OAuth client configuration when set", () => {
    const env = loadEnv({
      LINEAR_CLIENT_ID: "client-id-1",
      LINEAR_CLIENT_SECRET: "client-secret-1",
      REDIS_HOST: "localhost",
    });

    expect(env.linearClientId).toBe("client-id-1");
    expect(env.linearClientSecret).toBe("client-secret-1");
  });

  test("applies defaults", () => {
    const env = loadEnv({ REDIS_HOST: "localhost" });

    expect(env.dockerHost).toBe("local");
    expect(env.redisPort).toBe(6379);
  });

  test("coerces Redis port", () => {
    const env = loadEnv({ REDIS_HOST: "localhost", REDIS_PORT: "6380" });

    expect(env.redisPort).toBe(6380);
  });

  test("allows startup before the Linear app is configured", () => {
    const env = loadEnv({ REDIS_HOST: "localhost" });

    expect(env.linearClientId).toBeUndefined();
    expect(env.linearWebhookSecret).toBeUndefined();
  });

  test("requires Redis host", () => {
    expect(() => loadEnv({})).toThrow();
  });
});
