import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@hermes/core";
import type { ConnectFlow } from "@hermes/google-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OauthCallbackBinding, createOauthCallbackRoute } from "../build-oauth-callback-route";

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeConnectFlow(completeConnect: ConnectFlow["completeConnect"]): ConnectFlow {
  return {
    startConnect: vi.fn(),
    completeConnect,
  };
}

function binding(overrides: Partial<OauthCallbackBinding> = {}): OauthCallbackBinding {
  return {
    connectFlow: fakeConnectFlow(vi.fn()),
    notify: vi.fn().mockResolvedValue(undefined),
    pendingStore: { consumePendingConnection: vi.fn() },
    ...overrides,
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
    const route = createOauthCallbackRoute({ logger: createMockLogger() });
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`);

    expect(response.status).toBe(503);
  });

  it("after bind(), a successful completeConnect serves the close-tab page and calls notify with the email", async () => {
    const route = createOauthCallbackRoute({ logger: createMockLogger() });
    const notify = vi.fn().mockResolvedValue(undefined);
    route.bind(
      binding({
        connectFlow: fakeConnectFlow(
          vi.fn().mockResolvedValue({ ok: true, email: "person@example.com", chatId: "chat-1" }),
        ),
        notify,
      }),
    );
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("close this tab");
    expect(html).not.toContain("abc");
    expect(html).not.toContain("def");
    expect(notify).toHaveBeenCalledWith("chat-1", "Connected as person@example.com.");
  });

  it("a partial-grant completeConnect (identity connected, Sheets missing) still serves the close-tab page but notifies with a distinct message naming the shortfall and the retry command", async () => {
    const route = createOauthCallbackRoute({ logger: createMockLogger() });
    const notify = vi.fn().mockResolvedValue(undefined);
    route.bind(
      binding({
        connectFlow: fakeConnectFlow(
          vi.fn().mockResolvedValue({
            ok: true,
            email: "person@example.com",
            chatId: "chat-1",
            missingScopes: ["https://www.googleapis.com/auth/spreadsheets"],
          }),
        ),
        notify,
      }),
    );
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`);
    const html = await response.text();

    // The close-tab page and 200 status are exactly what a full grant gets —
    // the account IS connected, unlike an `ok: false` rejection — only the
    // notify text differs. `completeConnect` itself only reaches `ok: true`
    // (full or partial) after persisting the account (`connect-flow.ts`), so
    // this response confirms the same persisted-account path ran here too.
    expect(response.status).toBe(200);
    expect(html).toContain("close this tab");
    // The exact shipped wording for the Sheets-only case — unchanged by
    // deriving it from `missingScopes` instead of hardcoding "Sheets".
    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      "Connected as person@example.com. Sheets access wasn't granted — run /connect google sheets again and approve the Sheets permission to enable it.",
    );
  });

  it("a partial grant naming more than one missing scope lists every one of them, not just Sheets", async () => {
    const route = createOauthCallbackRoute({ logger: createMockLogger() });
    const notify = vi.fn().mockResolvedValue(undefined);
    route.bind(
      binding({
        connectFlow: fakeConnectFlow(
          vi.fn().mockResolvedValue({
            ok: true,
            email: "person@example.com",
            chatId: "chat-1",
            missingScopes: [
              "https://www.googleapis.com/auth/spreadsheets",
              "https://www.googleapis.com/auth/some-future-scope",
            ],
          }),
        ),
        notify,
      }),
    );
    await listen(route.handleRequest);

    await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`);

    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      "Connected as person@example.com. Sheets, https://www.googleapis.com/auth/some-future-scope access wasn't granted — run /connect google sheets again and approve the Sheets, https://www.googleapis.com/auth/some-future-scope permission to enable it.",
    );
  });

  it("a failed completeConnect serves a generic failure page and never calls notify", async () => {
    const route = createOauthCallbackRoute({ logger: createMockLogger() });
    const notify = vi.fn().mockResolvedValue(undefined);
    route.bind(
      binding({
        connectFlow: fakeConnectFlow(
          vi.fn().mockResolvedValue({ ok: false, reason: "invalid_state" }),
        ),
        notify,
      }),
    );
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
    const route = createOauthCallbackRoute({ logger: createMockLogger() });
    const completeConnect = vi.fn();
    route.bind(binding({ connectFlow: fakeConnectFlow(completeConnect) }));
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback`);

    expect(response.status).toBe(400);
    expect(completeConnect).not.toHaveBeenCalled();
  });

  it("logs a thrown completeConnect failure server-side while the response body stays the static failure page", async () => {
    const logger = createMockLogger();
    const route = createOauthCallbackRoute({ logger });
    const notify = vi.fn().mockResolvedValue(undefined);
    route.bind(
      binding({
        connectFlow: fakeConnectFlow(
          vi.fn().mockRejectedValue(new Error("response carried no refresh_token")),
        ),
        notify,
      }),
    );
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=secret-code&state=st4te`);
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(logger.error).toHaveBeenCalledWith("oauth callback failed", {
      error: "response carried no refresh_token",
    });
    expect(html).not.toContain("refresh_token");
    expect(html).not.toContain("secret-code");
    expect(html).not.toContain("st4te");
    expect(notify).not.toHaveBeenCalled();
  });

  it("logs only the error message, never the error object whose cause can carry the client secret", async () => {
    const logger = createMockLogger();
    const route = createOauthCallbackRoute({ logger });
    const rejection = new Error("invalid_client", {
      cause: { config: { data: "client_secret=super-secret" } },
    });
    route.bind(binding({ connectFlow: fakeConnectFlow(vi.fn().mockRejectedValue(rejection)) }));
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`);

    expect(response.status).toBe(400);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("super-secret");
  });

  it("rejects a non-GET request without consuming the state", async () => {
    const route = createOauthCallbackRoute({ logger: createMockLogger() });
    const completeConnect = vi.fn();
    const consumePendingConnection = vi.fn();
    route.bind(
      binding({
        connectFlow: fakeConnectFlow(completeConnect),
        pendingStore: { consumePendingConnection },
      }),
    );
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?code=abc&state=def`, {
      method: "POST",
    });
    const html = await response.text();

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(completeConnect).not.toHaveBeenCalled();
    expect(consumePendingConnection).not.toHaveBeenCalled();
    expect(html).not.toContain("abc");
    expect(html).not.toContain("def");
  });

  it("handles Google's denial redirect by consuming the pending state and never exchanging a code", async () => {
    const logger = createMockLogger();
    const route = createOauthCallbackRoute({ logger });
    const completeConnect = vi.fn();
    const consumePendingConnection = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    route.bind(
      binding({
        connectFlow: fakeConnectFlow(completeConnect),
        notify,
        pendingStore: { consumePendingConnection },
      }),
    );
    await listen(route.handleRequest);

    const response = await fetch(`${baseUrl}/oauth/callback?error=access_denied&state=st4te`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(consumePendingConnection).toHaveBeenCalledWith("st4te");
    expect(completeConnect).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("oauth callback: authorization was not granted", {
      error: "access_denied",
    });
    expect(html).toContain("not approved");
    expect(html).not.toContain("access_denied");
    expect(html).not.toContain("st4te");
  });
});
