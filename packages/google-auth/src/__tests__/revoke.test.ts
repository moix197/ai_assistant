import type { Logger } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import { revokeToken } from "../revoke";

const REFRESH_TOKEN = "super-secret-refresh-token";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function jsonAllTexts(mockFn: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(mockFn.mock.calls);
}

describe("revokeToken", () => {
  it("calls the revoke endpoint with the token as a query param", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const logger = fakeLogger();

    await revokeToken(REFRESH_TOKEN, { logger, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(REFRESH_TOKEN)}`,
    );
    expect(init.method).toBe("POST");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resolves (does not throw) on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const logger = fakeLogger();

    await expect(revokeToken(REFRESH_TOKEN, { logger, fetchImpl })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("resolves (does not throw) on a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const logger = fakeLogger();

    await expect(revokeToken(REFRESH_TOKEN, { logger, fetchImpl })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("never leaks the refresh token into a log call, on success or failure", async () => {
    const okFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const okLogger = fakeLogger();
    await revokeToken(REFRESH_TOKEN, { logger: okLogger, fetchImpl: okFetch });
    expect(jsonAllTexts(okLogger.warn as ReturnType<typeof vi.fn>)).not.toContain(REFRESH_TOKEN);
    expect(jsonAllTexts(okLogger.info as ReturnType<typeof vi.fn>)).not.toContain(REFRESH_TOKEN);

    const failFetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const failLogger = fakeLogger();
    await revokeToken(REFRESH_TOKEN, { logger: failLogger, fetchImpl: failFetch });
    expect(jsonAllTexts(failLogger.warn as ReturnType<typeof vi.fn>)).not.toContain(REFRESH_TOKEN);

    const networkFailFetch = vi.fn().mockRejectedValue(new Error(`boom ${REFRESH_TOKEN}`));
    const networkFailLogger = fakeLogger();
    await revokeToken(REFRESH_TOKEN, { logger: networkFailLogger, fetchImpl: networkFailFetch });
    expect(jsonAllTexts(networkFailLogger.warn as ReturnType<typeof vi.fn>)).not.toContain(
      REFRESH_TOKEN,
    );
  });

  it("never leaks the refresh token into a thrown error's message", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`network died: ${REFRESH_TOKEN}`));
    const logger = fakeLogger();
    let caught: unknown;

    try {
      // revokeToken never throws, but exercise the internal attempt path
      // directly-adjacent behavior by asserting the swallowed error's own
      // message (surfaced via the logger) is redacted too.
      await revokeToken(REFRESH_TOKEN, { logger, fetchImpl });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    const loggedMessage = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      error: string;
    };
    expect(loggedMessage.error).not.toContain(REFRESH_TOKEN);
  });
});
