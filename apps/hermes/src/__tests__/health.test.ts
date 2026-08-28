import type { AddressInfo } from "node:net";
import type { Pool } from "@hermes/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHealthServer } from "../health";

function createMockPool(queryImpl: () => Promise<unknown> = () => Promise.resolve()): Pool {
  return { query: vi.fn().mockImplementation(queryImpl) } as unknown as Pool;
}

describe("startHealthServer", () => {
  let baseUrl: string;
  let stopServer: () => void;
  let handleOauthCallback: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const pool = createMockPool();
    handleOauthCallback = vi.fn((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("bound");
    });

    const server = await new Promise<ReturnType<typeof startHealthServer>>((resolve) => {
      const s = startHealthServer(
        pool,
        0,
        { onError: () => {}, onListening: () => resolve(s) },
        handleOauthCallback,
      );
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    stopServer = () => server.close();
  });

  afterEach(() => {
    stopServer();
  });

  it("still serves /health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok", db: "connected" });
  });

  it("no longer 404s /health solely because of a query string", async () => {
    const response = await fetch(`${baseUrl}/health?x=1`);
    expect(response.status).toBe(200);
  });

  it("routes /oauth/callback to the bound handler", async () => {
    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bound");
    expect(handleOauthCallback).toHaveBeenCalledTimes(1);
  });

  it("still 404s an unrelated path", async () => {
    const response = await fetch(`${baseUrl}/nonexistent`);
    expect(response.status).toBe(404);
  });
});
