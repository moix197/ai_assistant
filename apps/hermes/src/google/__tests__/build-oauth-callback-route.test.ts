import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectFlow } from "@hermes/google-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOauthCallbackRoute } from "../build-oauth-callback-route";

function fakeConnectFlow(completeConnect: ConnectFlow["completeConnect"]): ConnectFlow {
  return {
    startConnect: vi.fn(),
    completeConnect,
  };
}

describe("createOauthCallbackRoute", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer();
  });

  afterEach(() => {
    server.close();
  });

  function listen(
    handleRequest: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void,
  ) {
    server.on("request", handleRequest);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  it("returns 503 before bind() is called", async () => {
    const route = createOauthCallbackRoute();
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`);

    expect(response.status).toBe(503);
  });

  it("after bind(), a successful completeConnect serves the close-tab page and calls notify with the email", async () => {
    const route = createOauthCallbackRoute();
    const connectFlow = fakeConnectFlow(
      vi.fn().mockResolvedValue({ ok: true, email: "person@example.com", chatId: "chat-1" }),
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    route.bind(connectFlow, notify);
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("close this tab");
    expect(html).not.toContain("abc");
    expect(html).not.toContain("def");
    expect(notify).toHaveBeenCalledWith("chat-1", "Connected as person@example.com.");
  });

  it("a failed completeConnect serves a generic failure page and never calls notify", async () => {
    const route = createOauthCallbackRoute();
    const connectFlow = fakeConnectFlow(
      vi.fn().mockResolvedValue({ ok: false, reason: "invalid_state" }),
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    route.bind(connectFlow, notify);
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=bad`);
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).not.toContain("abc");
    expect(html).not.toContain("bad");
    expect(html).not.toContain("invalid_state");
    expect(notify).not.toHaveBeenCalled();
  });

  it("missing code/state query params serves the failure page without calling completeConnect", async () => {
    const route = createOauthCallbackRoute();
    const completeConnect = vi.fn();
    route.bind(fakeConnectFlow(completeConnect), vi.fn());
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback`);

    expect(response.status).toBe(400);
    expect(completeConnect).not.toHaveBeenCalled();
  });
});
