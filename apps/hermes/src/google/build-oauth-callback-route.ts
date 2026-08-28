import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "@hermes/core";
import type { ConnectFlow, PendingConnectionStore } from "@hermes/google-auth";

/** Static — never echoes `code`, `state`, or any token material. */
const CLOSE_TAB_HTML =
  "<!doctype html><html><head><title>Connected</title></head><body>You can close this tab.</body></html>";
/** Static — never echoes error detail. */
const FAILURE_HTML =
  "<!doctype html><html><head><title>Connection failed</title></head><body>Something went wrong connecting your Google account. Please try <code>/connect google</code> again.</body></html>";
/** Static — never echoes Google's `error` value. */
const DENIED_HTML =
  "<!doctype html><html><head><title>Connection not approved</title></head><body>Your Google account was not connected because access was not approved. Run <code>/connect google</code> if you want to try again.</body></html>";

type NotifyChat = (chatId: string, text: string) => Promise<void>;

export interface OauthCallbackBinding {
  connectFlow: ConnectFlow;
  notify: NotifyChat;
  /**
   * Narrowed to the one operation the denial path needs: when Google
   * redirects back with `error=access_denied` there is no code to exchange,
   * so `completeConnect` can't be the seam that clears the pending entry —
   * without this it would linger for its full 10-minute TTL.
   */
  pendingStore: Pick<PendingConnectionStore, "consumePendingConnection">;
}

export interface OauthCallbackRouteDeps {
  logger: Logger;
}

export interface OauthCallbackRoute {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => void;
  bind(binding: OauthCallbackBinding): void;
}

interface CallbackQuery {
  code: string | null;
  state: string | null;
  error: string | null;
}

function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

function parseCallbackQuery(req: IncomingMessage): CallbackQuery {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
  };
}

/**
 * Google's denial redirect (`?error=access_denied`, and every other
 * `error` value it can send) carries no code, so the pending entry is
 * consumed here instead — the user declining is a finished flow, not one
 * left open until its TTL expires. `200`, not `400`: nothing about the
 * request was malformed.
 */
function handleAuthorizationDenied(
  binding: OauthCallbackBinding,
  logger: Logger,
  query: CallbackQuery,
  res: ServerResponse,
): void {
  if (query.state) binding.pendingStore.consumePendingConnection(query.state);
  logger.warn("oauth callback: authorization was not granted", { error: query.error });
  sendHtml(res, 200, DENIED_HTML);
}

/**
 * Consumes `state`/`code`, serves the static result page, and — only on
 * success — notifies the connecting chat. Every failure is logged
 * server-side and answered with a body that carries none of its detail:
 * without the log an unusable connect (a rejected client secret, a
 * refresh_token-less response, an id token missing its email claim) would
 * leave the operator nothing at all to debug from.
 */
async function handleBoundRequest(
  binding: OauthCallbackBinding,
  logger: Logger,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const query = parseCallbackQuery(req);
    if (query.error !== null) {
      handleAuthorizationDenied(binding, logger, query, res);
      return;
    }
    if (!query.code || !query.state) {
      logger.warn("oauth callback: request carried no code/state");
      sendHtml(res, 400, FAILURE_HTML);
      return;
    }

    const result = await binding.connectFlow.completeConnect(query.state, query.code);
    if (!result.ok) {
      logger.warn("oauth callback: connect could not be completed", { reason: result.reason });
      sendHtml(res, 400, FAILURE_HTML);
      return;
    }

    sendHtml(res, 200, CLOSE_TAB_HTML);
    await binding.notify(result.chatId, `Connected as ${result.email}.`);
  } catch (error) {
    // `error.message` only, never the error object or its `cause`: a failed
    // token exchange rejects with a GaxiosError whose `config.data` holds
    // GOOGLE_CLIENT_SECRET and the authorization code.
    logger.error("oauth callback failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) sendHtml(res, 400, FAILURE_HTML);
  }
}

/**
 * The mutable-holder indirection Dependencies & Risks describes:
 * `apps/hermes/src/boot.ts` constructs this before the Telegram channel
 * exists, so its `handleRequest` can be wired into the health server's
 * router immediately; `wireRuntimeAndShutdown` calls `.bind()` once
 * `connectFlow` and the channel (for `notify`) exist. A callback arriving
 * before `bind()` runs gets a `503` — only possible if Google redirects back
 * before Hermes finishes booting, which cannot happen (the operator can't
 * reach `/connect google` until the bot is live).
 */
export function createOauthCallbackRoute(deps: OauthCallbackRouteDeps): OauthCallbackRoute {
  let binding: OauthCallbackBinding | undefined;

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Google's redirect is always a GET; anything else reaching this path is
    // not the flow, and must not spend a single-use `state` on it.
    if (req.method !== "GET") {
      sendHtml(res, 405, FAILURE_HTML, { Allow: "GET" });
      return;
    }
    if (!binding) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("not ready");
      return;
    }
    void handleBoundRequest(binding, deps.logger, req, res);
  }

  function bind(next: OauthCallbackBinding): void {
    binding = next;
  }

  return { handleRequest, bind };
}
