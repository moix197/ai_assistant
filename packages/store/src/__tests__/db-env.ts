/**
 * Resolves `TEST_DATABASE_URL` for the DB integration lane, falling back to the
 * repo-root `.env` when the shell did not set it.
 *
 * Shared with every DB-gated suite in the monorepo — `apps/hermes` reaches it
 * through the `@hermes/store/testing` subpath export, deliberately kept off the
 * package's runtime entry point so test-only code never lands in `dist`. The
 * resolver and the `assertNotTheAppDatabase` guard below travel together on
 * purpose: a caller that copies only the resolver loses the one check that
 * stops a mis-set URL from truncating real spend history.
 *
 * Mirrors `packages/llm/src/__tests__/live/setup.ts`: there is no
 * `vitest.config.ts` anywhere (the plan forbids one), so nothing loads `.env`
 * for us and each gated lane loads it itself. As with the live lane, a missing
 * key is a *skip*, never a failure — `pnpm test` must stay credential-free.
 * `pnpm test:db` is the lane that turns the same absence into a hard error, via
 * its own guard in `package.json`; without that guard the `skipIf` below would
 * make an empty run indistinguishable from a passing one.
 *
 * Also provisions the scratch database itself (`ensureTestDatabaseExists`)
 * so a fresh worktree needs no manual `CREATE DATABASE`. See
 * `.ai/decisions/test-database-isolation.md`.
 */

import { fileURLToPath } from "node:url";
import { Client } from "pg";

/** The repo-root `.env`, four directories up from `src/__tests__/`. */
const REPO_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));

/**
 * Node's `process.loadEnvFile` never overwrites a key already in `process.env`,
 * so an explicitly exported value still wins. A missing or unreadable `.env` is
 * not an error: the key stays absent and the suites skip as before.
 */
function loadRepoEnvFileWhenDatabaseUrlIsMissing(): void {
  if ((process.env.TEST_DATABASE_URL ?? "").trim() !== "") return;
  try {
    process.loadEnvFile(REPO_ENV_FILE);
  } catch {
    // No readable `.env`; the suites skip with their usual message.
  }
}

loadRepoEnvFileWhenDatabaseUrlIsMissing();

/**
 * Extracts the database name from a Postgres connection URL. Centralized so
 * every call site agrees on how the name is parsed out of the URL's path.
 */
function getTestDatabaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/**
 * Refuses a URL that names the app's own database. These suites seed and
 * truncate `llm_usage`, and a row they leave behind is spend the budget
 * ceiling reads as real: a stray run against the app database permanently
 * lowers the effective cap, in dollars, with nothing reporting it. That is not
 * hypothetical — a `provider: "p", model: "m1", cost_usd: 0.005` fixture row
 * reached the dev app database once and accounted for 92% of the month's
 * apparent spend.
 *
 * Two independent checks, because either alone has a hole: matching
 * `DATABASE_URL` catches the app database even when it is not named `hermes`,
 * and the `_test` suffix catches a hand-typed URL on a host where
 * `DATABASE_URL` happens to be unset. Throwing beats skipping here — a silent
 * skip is how the misconfiguration would survive.
 */
function assertNotTheAppDatabase(url: string): void {
  const appDatabaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (appDatabaseUrl !== "" && url === appDatabaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL points at DATABASE_URL, the app's own database. " +
        "These tests truncate llm_usage and leave fixture rows the budget " +
        "ceiling counts as real spend. Point it at a scratch database.",
    );
  }
  const databaseName = getTestDatabaseName(url);
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL names database "${databaseName}", which does not end in "_test". Refusing to run: these tests truncate llm_usage and their fixture rows are counted as real spend by the budget ceiling.`,
    );
  }
}

/**
 * Postgres codes for "database already exists" — raised if a concurrent
 * `CREATE DATABASE` won the race against this one: `42P04` is the dedicated
 * duplicate_database code, and `23505` (unique_violation) is what a
 * concurrent creator can raise instead when it collides on the system
 * catalog under relaxed concurrency. Both are treated as success: the goal
 * is the database existing, not this call being the one that made it.
 */
const DUPLICATE_DATABASE_ERROR_CODES = new Set(["42P04", "23505"]);

/**
 * Guards the identifier interpolated into `CREATE DATABASE "<name>"`.
 * Redundant with `assertNotTheAppDatabase`'s `_test` suffix check, but that
 * check exists to stop the wrong database from being touched, not to make
 * the interpolation itself safe — this makes the quoting deliberate rather
 * than incidentally safe because `URL` happens to percent-encode a stray `"`.
 */
function assertSafeDatabaseIdentifier(databaseName: string): void {
  if (!/^[a-z0-9_]+_test$/i.test(databaseName)) {
    throw new Error(
      `Refusing to interpolate database name "${databaseName}" into SQL: it must match /^[a-z0-9_]+_test$/i.`,
    );
  }
}

/**
 * Creates the scratch database named by `url` when it does not already
 * exist, so a fresh worktree's `pnpm test:db` needs no manual `psql` step.
 * Connects to Postgres's own `postgres` maintenance database on the same
 * host/user/credentials as `url` — `CREATE DATABASE` cannot run on the
 * connection being created, and every Postgres instance this project touches
 * (compose's `postgres:16-alpine`, CI's `postgres:16` service container)
 * keeps a `postgres` database regardless of what `POSTGRES_DB` names.
 *
 * CI is unaffected: its service container already sets `POSTGRES_DB` to the
 * scratch name (see `.github/workflows/ci.yml`), so this finds the database
 * already present and does nothing.
 */
async function ensureTestDatabaseExists(url: string): Promise<void> {
  const databaseName = getTestDatabaseName(url);
  assertSafeDatabaseIdentifier(databaseName);
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = "/postgres";

  const client = new Client({ connectionString: maintenanceUrl.toString() });
  try {
    try {
      await client.connect();
    } catch (error) {
      throw new Error(
        `Could not reach Postgres at ${maintenanceUrl.host} to provision scratch database "${databaseName}": ${(error as Error).message}. Start the compose stack (docker compose up -d postgres) and retry.`,
      );
    }
    try {
      const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
        databaseName,
      ]);
      if (!rowCount) {
        await client.query(`CREATE DATABASE "${databaseName}"`);
      }
    } catch (error) {
      if (!DUPLICATE_DATABASE_ERROR_CODES.has((error as { code?: string }).code ?? "")) {
        throw new Error(
          `Could not provision scratch database "${databaseName}": ${(error as Error).message}`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

/** The scratch-database URL, or `undefined` when the lane should skip. */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() || undefined;

if (testDatabaseUrl) {
  assertNotTheAppDatabase(testDatabaseUrl);
  await ensureTestDatabaseExists(testDatabaseUrl);
}
