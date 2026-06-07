import Redis from "ioredis";
import type { Env } from "../config/env";

export type RedisClient = Redis;

export class MissingRedisConfigError extends Error {
  constructor() {
    super("REDIS_HOST is required");
    this.name = "MissingRedisConfigError";
  }
}

export function createRedisClient(env: Env): RedisClient {
  if (!env.redisHost) {
    throw new MissingRedisConfigError();
  }

  console.log(`[redis] creating Redis client for ${env.redisHost}:${env.redisPort}`);

  const redis = new Redis({
    host: env.redisHost,
    port: env.redisPort,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  redis.on("connect", () => console.log("[redis] connected"));
  redis.on("ready", () => console.log("[redis] ready"));
  redis.on("close", () => console.log("[redis] connection closed"));
  redis.on("reconnecting", () => console.log("[redis] reconnecting"));
  redis.on("error", (error) => console.log(`[redis] error: ${error.message}`));

  return redis;
}
