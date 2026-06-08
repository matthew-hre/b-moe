import Redis from "ioredis";
import { createLogger } from "../logger";
import type { Env } from "../config/env";

const logger = createLogger("redis");

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

  logger.info(`creating Redis client for ${env.redisHost}:${env.redisPort}`);

  const redis = new Redis({
    host: env.redisHost,
    port: env.redisPort,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });

  redis.on("connect", () => logger.info("connected"));
  redis.on("ready", () => logger.info("ready"));
  redis.on("close", () => logger.info("connection closed"));
  redis.on("reconnecting", () => logger.info("reconnecting"));
  redis.on("error", (error) => logger.error(`error: ${error.message}`));

  return redis;
}
