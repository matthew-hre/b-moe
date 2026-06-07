import { describe, expect, test } from "bun:test";
import { type Run, transitionRun } from "../src/models/run";
import {
  InMemoryRunStore,
  RedisRunStore,
  RunAlreadyExistsError,
  RunNotFoundError,
  type RedisRunStoreClient,
  type RedisRunStoreTransaction,
  type RunStore,
} from "../src/store/run.store";

class FakeRedisTransaction implements RedisRunStoreTransaction {
  private readonly writes: Array<{ type: "set" | "sadd"; key: string; value: string }> = [];

  constructor(
    private readonly values: Map<string, string>,
    private readonly sets: Map<string, Set<string>>,
  ) {}

  set(key: string, value: string): RedisRunStoreTransaction {
    this.writes.push({ type: "set", key, value });

    return this;
  }

  sadd(key: string, value: string): RedisRunStoreTransaction {
    this.writes.push({ type: "sadd", key, value });

    return this;
  }

  async exec(): Promise<unknown> {
    for (const write of this.writes) {
      if (write.type === "set") {
        this.values.set(write.key, write.value);
      } else {
        const set = this.sets.get(write.key) ?? new Set<string>();
        set.add(write.value);
        this.sets.set(write.key, set);
      }
    }

    return [];
  }
}

class FakeRedis implements RedisRunStoreClient {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.values.set(key, value);

    return "OK";
  }

  async sadd(key: string, value: string): Promise<unknown> {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(value);
    this.sets.set(key, set);

    return 1;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  multi(): RedisRunStoreTransaction {
    return new FakeRedisTransaction(this.values, this.sets);
  }
}

function createInMemoryStore(now = new Date("2025-01-01T00:00:00.000Z")): RunStore {
  return new InMemoryRunStore({
    createRunId: () => "run-1",
    getCurrentDate: () => now,
  });
}

function createRedisStore(now = new Date("2025-01-01T00:00:00.000Z")): RunStore {
  return new RedisRunStore({
    redisClient: new FakeRedis(),
    createRunId: () => "run-1",
    getCurrentDate: () => now,
  });
}

function runStoreContract(name: string, createStore: (now?: Date) => RunStore): void {
  describe(name, () => {
    test("creates queued runs", async () => {
      const now = new Date("2025-01-01T00:00:00.000Z");
      const store = createStore(now);

      const run = await store.createRun({
        agentSessionId: "session-1",
        linearIssueId: "issue-1",
        promptContext: "<issue><title>Do the thing</title></issue>",
      });

      expect(run).toEqual({
        id: "run-1",
        agentSessionId: "session-1",
        linearIssueId: "issue-1",
        promptContext: "<issue><title>Do the thing</title></issue>",
        state: "queued",
        createdAt: now,
        updatedAt: now,
      });
    });

    test("gets runs by id", async () => {
      const store = createStore();
      const createdRun = await store.createRun({
        agentSessionId: "session-1",
        linearIssueId: "issue-1",
      });

      const foundRun = await store.getRun(createdRun.id);

      expect(foundRun).toEqual(createdRun);
    });

    test("gets runs by agent session id", async () => {
      const store = createStore();
      const createdRun = await store.createRun({
        agentSessionId: "session-1",
        linearIssueId: "issue-1",
      });

      expect(store.getRunByAgentSession("session-1")).resolves.toEqual(createdRun);
      expect(store.getRunByAgentSession("session-missing")).resolves.toBeUndefined();
    });

    test("returns undefined for missing runs", async () => {
      const store = createStore();

      expect(store.getRun("missing-run")).resolves.toBeUndefined();
    });

    test("saves valid runs", async () => {
      const store = createStore();
      const run = await store.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });
      const transitionedRun = transitionRun(
        run,
        "refining",
        new Date("2025-01-01T01:00:00.000Z"),
      );

      expect(store.saveRun(transitionedRun)).resolves.toEqual(transitionedRun);
      expect(store.getRun(run.id)).resolves.toEqual(transitionedRun);
    });

    test("validates runs before saving", async () => {
      const store = createStore();
      const invalidRun = {
        id: "",
        linearIssueId: "issue-1",
        state: "queued",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      } as Run;

      expect(store.saveRun(invalidRun)).rejects.toThrow();
    });

    test("rejects duplicate run ids", async () => {
      const store = createStore();

      await store.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });

      expect(store.createRun({ agentSessionId: "session-2", linearIssueId: "issue-2" })).rejects.toThrow(
        RunAlreadyExistsError,
      );
    });

    test("transitions stored runs", async () => {
      const transitionedAt = new Date("2025-01-01T01:00:00.000Z");
      const store = createStore(transitionedAt);
      const run = await store.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });

      const transitionedRun = await store.transitionRun(run.id, "refining");

      expect(transitionedRun).toEqual({
        ...run,
        state: "refining",
        updatedAt: transitionedAt,
      });
      expect(store.getRun(run.id)).resolves.toEqual(transitionedRun);
    });

    test("throws when transitioning missing runs", async () => {
      const store = createStore();

      expect(store.transitionRun("missing-run", "refining")).rejects.toThrow(
        RunNotFoundError,
      );
    });
  });
}

runStoreContract("InMemoryRunStore", createInMemoryStore);
runStoreContract("RedisRunStore", createRedisStore);

describe("run store listRuns", () => {
  test.each([
    ["InMemoryRunStore", () => {
      let nextId = 1;
      return new InMemoryRunStore({
        createRunId: () => `run-${nextId++}`,
        getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
      });
    }],
    ["RedisRunStore", () => {
      let nextId = 1;
      return new RedisRunStore({
        redisClient: new FakeRedis(),
        createRunId: () => `run-${nextId++}`,
        getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
      });
    }],
  ] satisfies Array<[string, () => RunStore]>)
    ("lists runs from %s", async (_name, createStoreWithIds) => {
      const store = createStoreWithIds();

      const firstRun = await store.createRun({ agentSessionId: "session-1", linearIssueId: "issue-1" });
      const secondRun = await store.createRun({ agentSessionId: "session-2", linearIssueId: "issue-2" });

      expect(store.listRuns()).resolves.toEqual([firstRun, secondRun]);
    });
});
