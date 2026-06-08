import { randomUUID } from "node:crypto";

export interface SteeringMessage {
  readonly id: string;
  readonly runId: string;
  readonly body: string;
  readonly createdAt: Date;
}

export interface SteeringStore {
  enqueue(input: { readonly runId: string; readonly body: string }): Promise<SteeringMessage>;
  drain(runId: string): Promise<readonly SteeringMessage[]>;
}

export type CreateSteeringMessageId = () => string;
export type GetCurrentDate = () => Date;

export interface RedisSteeringStoreClient {
  rpush(key: string, value: string): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string): Promise<unknown>;
}

export interface RedisSteeringStoreDependencies {
  readonly redisClient: RedisSteeringStoreClient;
  readonly createMessageId?: CreateSteeringMessageId;
  readonly getCurrentDate?: GetCurrentDate;
}

export interface InMemorySteeringStoreDependencies {
  readonly createMessageId?: CreateSteeringMessageId;
  readonly getCurrentDate?: GetCurrentDate;
}

const REDIS_STEERING_KEY_PREFIX = "run:steering:";

export class RedisSteeringStore implements SteeringStore {
  private readonly redis: RedisSteeringStoreClient;
  private readonly createMessageId: CreateSteeringMessageId;
  private readonly getCurrentDate: GetCurrentDate;

  constructor({
    redisClient,
    createMessageId = randomUUID,
    getCurrentDate = () => new Date(),
  }: RedisSteeringStoreDependencies) {
    this.redis = redisClient;
    this.createMessageId = createMessageId;
    this.getCurrentDate = getCurrentDate;
  }

  async enqueue(input: { readonly runId: string; readonly body: string }): Promise<SteeringMessage> {
    const message = createSteeringMessage(input, this.createMessageId, this.getCurrentDate);
    await this.redis.rpush(steeringKey(input.runId), serializeMessage(message));

    return message;
  }

  async drain(runId: string): Promise<readonly SteeringMessage[]> {
    const key = steeringKey(runId);
    const values = await this.redis.lrange(key, 0, -1);

    if (values.length === 0) {
      return [];
    }

    await this.redis.del(key);

    return values.map(deserializeMessage);
  }
}

export class InMemorySteeringStore implements SteeringStore {
  private readonly createMessageId: CreateSteeringMessageId;
  private readonly getCurrentDate: GetCurrentDate;
  private readonly messagesByRunId = new Map<string, SteeringMessage[]>();

  constructor({
    createMessageId = randomUUID,
    getCurrentDate = () => new Date(),
  }: InMemorySteeringStoreDependencies = {}) {
    this.createMessageId = createMessageId;
    this.getCurrentDate = getCurrentDate;
  }

  async enqueue(input: { readonly runId: string; readonly body: string }): Promise<SteeringMessage> {
    const message = createSteeringMessage(input, this.createMessageId, this.getCurrentDate);
    const messages = this.messagesByRunId.get(input.runId) ?? [];
    messages.push(message);
    this.messagesByRunId.set(input.runId, messages);

    return message;
  }

  async drain(runId: string): Promise<readonly SteeringMessage[]> {
    const messages = this.messagesByRunId.get(runId) ?? [];
    this.messagesByRunId.delete(runId);

    return messages;
  }
}

function createSteeringMessage(
  input: { readonly runId: string; readonly body: string },
  createMessageId: CreateSteeringMessageId,
  getCurrentDate: GetCurrentDate,
): SteeringMessage {
  return {
    id: createMessageId(),
    runId: input.runId,
    body: input.body,
    createdAt: getCurrentDate(),
  };
}

function steeringKey(runId: string): string {
  return `${REDIS_STEERING_KEY_PREFIX}${runId}`;
}

function serializeMessage(message: SteeringMessage): string {
  return JSON.stringify({
    ...message,
    createdAt: message.createdAt.toISOString(),
  });
}

function deserializeMessage(value: string): SteeringMessage {
  const parsed = JSON.parse(value) as {
    readonly id: string;
    readonly runId: string;
    readonly body: string;
    readonly createdAt: string;
  };

  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
  };
}
