import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireInstanceLock } from "../advisory-lock";

// Unit coverage for the dropped-connection path, which no integration test can
// provoke deterministically: `pg` is replaced with a fake whose client is an
// EventEmitter, so the test can emit the 'error' event Postgres emits when the
// lock connection dies.
const { createdClients } = vi.hoisted(() => ({ createdClients: [] as EventEmitter[] }));

vi.mock("pg", async () => {
  const { EventEmitter: FakeEmitter } = await import("node:events");
  class FakeClient extends FakeEmitter {
    connect = vi.fn(async () => {});
    query = vi.fn(async () => ({ rows: [{ locked: true }] }));
    end = vi.fn(async () => {});

    constructor() {
      super();
      createdClients.push(this);
    }
  }
  return { Client: FakeClient };
});

describe("acquireInstanceLock — lock connection error", () => {
  beforeEach(() => {
    createdClients.length = 0;
  });

  it("routes a dropped lock connection to the fail-closed handler", async () => {
    const onConnectionError = vi.fn();
    const lock = await acquireInstanceLock(1, "postgres://fake/db", onConnectionError);
    expect(lock.acquired).toBe(true);

    const client = createdClients.at(-1) as EventEmitter;
    const error = new Error("Connection terminated unexpectedly");
    // EventEmitter throws an unhandled 'error' synchronously, so this line
    // failing is exactly the uncaught-exception regression being guarded.
    client.emit("error", error);

    expect(onConnectionError).toHaveBeenCalledWith(error);
  });
});
