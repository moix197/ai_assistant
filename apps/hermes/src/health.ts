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

function handleRequest(pool: Pool, req: IncomingMessage, res: ServerResponse): void {
  if (req.url === "/health") {
    void handleHealthCheck(pool, res);
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
): Server {
  const server = createServer((req, res) => handleRequest(pool, req, res));
  server.on("error", (error) => {
    callbacks.onError(error);
  });
  server.listen(port, () => {
    callbacks.onListening?.();
  });
  return server;
}
