import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { Pool } from "@hermes/store";

interface HealthStatus {
  status: "ok" | "error";
  db: "connected" | "disconnected";
}

/** Also used by `/ping` (see handlers/ping.ts) so DB-status logic isn't duplicated. */
export async function checkDbConnectivity(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function handleHealthCheck(pool: Pool, res: ServerResponse): Promise<void> {
  const dbConnected = await checkDbConnectivity(pool);
  const body: HealthStatus = {
    status: dbConnected ? "ok" : "error",
    db: dbConnected ? "connected" : "disconnected",
  };
  res.writeHead(dbConnected ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export type OauthCallbackHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Path/query-aware since Phase 2 (`04-google-auth`) — previously a strict
 * `req.url === "/health"` compare, which already 404'd `/health?x=1` and had
 * no query-string handling at all. `new URL(req.url, "http://localhost")`
 * gives a real `pathname` to switch on; `search` is ignored for `/health`
 * (query strings there carry no meaning) and parsed by the OAuth callback
 * route itself.
 */
function handleRequest(
  pool: Pool,
  handleOauthCallback: OauthCallbackHandler,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/health") {
    void handleHealthCheck(pool, res);
    return;
  }
  if (pathname === "/oauth/callback") {
    handleOauthCallback(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

export interface HealthServerCallbacks {
  onListening?: () => void;
  onError: (error: Error) => void;
}

export function startHealthServer(
  pool: Pool,
  port: number,
  callbacks: HealthServerCallbacks,
  handleOauthCallback: OauthCallbackHandler,
): Server {
  const server = createServer((req, res) => handleRequest(pool, handleOauthCallback, req, res));
  server.on("error", (error) => {
    callbacks.onError(error);
  });
  server.listen(port, () => {
    callbacks.onListening?.();
  });
  return server;
}
