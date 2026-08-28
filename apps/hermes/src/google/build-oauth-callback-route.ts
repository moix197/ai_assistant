import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConnectFlow } from "@hermes/google-auth";

/** Static — never echoes `code`, `state`, or any token material. */
const CLOSE_TAB_HTML =
  "<!doctype html><html><head><title>Connected</title></head><body>You can close this tab.</body></html>";
/** Static — never echoes error detail. */
const FAILURE_HTML =
  "<!doctype html><html><head><title>Connection failed</title></head><body>Something went wrong connecting your Google account. Please try <code>/connect google</code> again.</body></html>";

type NotifyChat = (chatId: string, text: string) => Promise<void>;

interface BoundDeps {
  connectFlow: ConnectFlow;
  notify: NotifyChat;
}

export interface OauthCallbackRoute {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => void;
  bind(connectFlow: ConnectFlow, notify: NotifyChat): void;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function parseCallbackParams(req: IncomingMessage): { code: string; state: string } | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return undefined;
  return { code, state };
}

/**
 * Consumes `state`/`code`, serves the static result page, and — only on
 * success — notifies the connecting chat. Any thrown error (a malformed
 * request, a failed token exchange) is caught here rather than left to
 * become an unhandled rejection; the response body still never carries the
 * error's detail, matching the same-shape `invalid_state` failure page.
 */
async function handleBoundRequest(
  bound: BoundDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const params = parseCallbackParams(req);
    if (!params) {
      sendHtml(res, 400, FAILURE_HTML);
      return;
    }

    const result = await bound.connectFlow.completeConnect(params.state, params.code);
    if (!result.ok) {
      sendHtml(res, 400, FAILURE_HTML);
      return;
    }

    sendHtml(res, 200, CLOSE_TAB_HTML);
    await bound.notify(result.chatId, `Connected as ${result.email}.`);
  } catch {
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
export function createOauthCallbackRoute(): OauthCallbackRoute {
  let bound: BoundDeps | undefined;

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!bound) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("not ready");
      return;
    }
    void handleBoundRequest(bound, req, res);
  }

  function bind(connectFlow: ConnectFlow, notify: NotifyChat): void {
    bound = { connectFlow, notify };
  }

  return { handleRequest, bind };
}
