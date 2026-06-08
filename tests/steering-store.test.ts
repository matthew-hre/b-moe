import { describe, expect, test } from "bun:test";
import {
  InMemorySteeringStore,
  RedisSteeringStore,
  type RedisSteeringStoreClient,
  type SteeringStore,
} from "../src/store/steering.store";

class FakeRedis implements RedisSteeringStoreClient {
  readonly lists = new Map<string, string[]>();

  async rpush(key: string, value: string): Promise<unknown> {
    const values = this.lists.get(key) ?? [];
    values.push(value);
    this.lists.set(key, values);

    return values.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const values = this.lists.get(key) ?? [];
    const end = stop === -1 ? values.length : stop + 1;

    return values.slice(start, end);
  }

  async del(key: string): Promise<unknown> {
    return this.lists.delete(key) ? 1 : 0;
  }
}

function createInMemoryStore(): SteeringStore {
  return new InMemorySteeringStore({
    createMessageId: createSequentialId(),
    getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
  });
}

function createRedisStore(): SteeringStore {
  return new RedisSteeringStore({
    redisClient: new FakeRedis(),
    createMessageId: createSequentialId(),
    getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
  });
}

function steeringStoreContract(name: string, createStore: () => SteeringStore): void {
  describe(name, () => {
    test("drains queued steering messages in order", async () => {
      const store = createStore();

      await store.enqueue({ runId: "run-1", body: "Use v2." });
      await store.enqueue({ runId: "run-1", body: "Add tests too." });

      expect(await store.drain("run-1")).toEqual([
        {
          id: "steering-1",
          runId: "run-1",
          body: "Use v2.",
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
        {
          id: "steering-2",
          runId: "run-1",
          body: "Add tests too.",
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
      ]);
      expect(await store.drain("run-1")).toEqual([]);
    });
  });
}

function createSequentialId(): () => string {
  let nextId = 1;

  return () => `steering-${nextId++}`;
}

steeringStoreContract("InMemorySteeringStore", createInMemoryStore);
steeringStoreContract("RedisSteeringStore", createRedisStore);
