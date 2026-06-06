import { describe, expect, test } from "bun:test";
import { type Run, transitionRun } from "../src/models/run";
import {
  InMemoryRunStore,
  RunAlreadyExistsError,
  RunNotFoundError,
} from "../src/store/run.store";

function createStore(now = new Date("2025-01-01T00:00:00.000Z")): InMemoryRunStore {
  return new InMemoryRunStore({
    createRunId: () => "run-1",
    getCurrentDate: () => now,
  });
}

describe("InMemoryRunStore", () => {
  test("creates queued runs", async () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const store = createStore(now);

    const run = await store.createRun({ linearIssueId: "issue-1" });

    expect(run).toEqual({
      id: "run-1",
      linearIssueId: "issue-1",
      state: "queued",
      createdAt: now,
      updatedAt: now,
    });
  });

  test("gets runs by id", async () => {
    const store = createStore();
    const createdRun = await store.createRun({ linearIssueId: "issue-1" });

    const foundRun = await store.getRun(createdRun.id);

    expect(foundRun).toEqual(createdRun);
  });

  test("returns undefined for missing runs", async () => {
    const store = createStore();

    expect(store.getRun("missing-run")).resolves.toBeUndefined();
  });

  test("lists runs", async () => {
    let nextId = 1;
    const store = new InMemoryRunStore({
      createRunId: () => `run-${nextId++}`,
      getCurrentDate: () => new Date("2025-01-01T00:00:00.000Z"),
    });

    const firstRun = await store.createRun({ linearIssueId: "issue-1" });
    const secondRun = await store.createRun({ linearIssueId: "issue-2" });

    expect(store.listRuns()).resolves.toEqual([firstRun, secondRun]);
  });

  test("saves valid runs", async () => {
    const store = createStore();
    const run = await store.createRun({ linearIssueId: "issue-1" });
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

    await store.createRun({ linearIssueId: "issue-1" });

    expect(store.createRun({ linearIssueId: "issue-2" })).rejects.toThrow(
      RunAlreadyExistsError,
    );
  });

  test("transitions stored runs", async () => {
    const transitionedAt = new Date("2025-01-01T01:00:00.000Z");
    const store = createStore(transitionedAt);
    const run = await store.createRun({ linearIssueId: "issue-1" });

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
