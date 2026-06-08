import { z } from "zod";
import { createLogger } from "../logger";

const logger = createLogger("linear-install-store");

export const LinearInstallSchema = z
  .object({
    appUserId: z.string().min(1),
    accessToken: z.string().min(1),
    scope: z.union([z.string(), z.array(z.string())]),
    expiresAt: z.date().optional(),
    refreshToken: z.string().min(1).optional(),
  })
  .strict();

export type LinearInstall = Readonly<z.infer<typeof LinearInstallSchema>>;

export interface LinearInstallStore {
  // Persist the app's install for a workspace, keyed by its per-workspace app
  // user id. Single-tenant per deployment for now, but keyed so a dev and prod
  // install never collide.
  saveInstall(install: LinearInstall): Promise<LinearInstall>;
  getInstall(appUserId?: string): Promise<LinearInstall | undefined>;
}

export interface RedisStringStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  multi(): RedisTransaction;
}

export interface RedisTransaction {
  set(key: string, value: string): RedisTransaction;
  exec(): Promise<unknown>;
}

const REDIS_DEFAULT_INSTALL_KEY = "linear:install:default";
const REDIS_INSTALL_KEY_PREFIX = "linear:install:";

const RedisLinearInstallSchema = z
  .object({
    appUserId: z.string().min(1),
    accessToken: z.string().min(1),
    scope: z.union([z.string(), z.array(z.string())]),
    expiresAt: z.string().datetime().optional(),
    refreshToken: z.string().min(1).optional(),
  })
  .strict();

function installKey(appUserId: string): string {
  return `${REDIS_INSTALL_KEY_PREFIX}${appUserId}`;
}

function serializeInstall(install: LinearInstall): string {
  return JSON.stringify({
    ...install,
    expiresAt: install.expiresAt?.toISOString(),
  });
}

function deserializeInstall(value: string): LinearInstall {
  const parsedInstall = RedisLinearInstallSchema.parse(JSON.parse(value));

  return LinearInstallSchema.parse({
    ...parsedInstall,
    expiresAt: parsedInstall.expiresAt ? new Date(parsedInstall.expiresAt) : undefined,
  });
}

export class RedisLinearInstallStore implements LinearInstallStore {
  private readonly redis: RedisStringStore;

  constructor(redis: RedisStringStore) {
    this.redis = redis;
  }

  async saveInstall(install: LinearInstall): Promise<LinearInstall> {
    const parsedInstall = LinearInstallSchema.parse(install);
    const serializedInstall = serializeInstall(parsedInstall);

    logger.info(`redis saving install appUserId=${parsedInstall.appUserId}`);

    await this.redis
      .multi()
      .set(installKey(parsedInstall.appUserId), serializedInstall)
      .set(REDIS_DEFAULT_INSTALL_KEY, parsedInstall.appUserId)
      .exec();

    logger.info(`redis saved install appUserId=${parsedInstall.appUserId}`);

    return parsedInstall;
  }

  async getInstall(appUserId?: string): Promise<LinearInstall | undefined> {
    logger.info(`redis getInstall requested appUserId=${appUserId ?? "default"}`);
    const resolvedAppUserId = appUserId ?? (await this.redis.get(REDIS_DEFAULT_INSTALL_KEY));

    if (!resolvedAppUserId) {
      logger.info("redis no default install found");
      return undefined;
    }

    const serializedInstall = await this.redis.get(installKey(resolvedAppUserId));

    if (!serializedInstall) {
      logger.info(`redis no install found for appUserId=${resolvedAppUserId}`);
      return undefined;
    }

    logger.info(`redis found install appUserId=${resolvedAppUserId}`);

    return deserializeInstall(serializedInstall);
  }
}

export class InMemoryLinearInstallStore implements LinearInstallStore {
  private readonly installs = new Map<string, LinearInstall>();

  async saveInstall(install: LinearInstall): Promise<LinearInstall> {
    const parsedInstall = LinearInstallSchema.parse(install);

    logger.info(`memory saving install appUserId=${parsedInstall.appUserId}`);
    this.installs.set(parsedInstall.appUserId, parsedInstall);

    return parsedInstall;
  }

  async getInstall(appUserId?: string): Promise<LinearInstall | undefined> {
    logger.info(`memory getInstall requested appUserId=${appUserId ?? "default"}`);

    if (appUserId) {
      const install = this.installs.get(appUserId);

      logger.info(
        `memory ${install ? "found" : "missing"} install appUserId=${appUserId}`,
      );

      return install ? LinearInstallSchema.parse(install) : undefined;
    }

    // Single-tenant convenience: return the only install when no id is given.
    const [install] = this.installs.values();

    logger.info(`memory ${install ? "found" : "missing"} default install`);

    return install ? LinearInstallSchema.parse(install) : undefined;
  }
}
