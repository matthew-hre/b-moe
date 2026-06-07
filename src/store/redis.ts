import Redis from "ioredis";
import type { Env } from "../config/env";

export type RedisClient = Redis;

export function createRedisClient(env: Env): RedisClient | undefined {
  if (!env.redisHost) {
    console.log("[redis] REDIS_HOST is not set; using in-memory stores");
    return undefined;
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
