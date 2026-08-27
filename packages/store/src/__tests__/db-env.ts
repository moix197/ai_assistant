/**
 * Resolves `TEST_DATABASE_URL` for the DB integration lane, falling back to the
 * repo-root `.env` when the shell did not set it.
 *
 * Mirrors `packages/llm/src/__tests__/live/setup.ts`: there is no
 * `vitest.config.ts` anywhere (the plan forbids one), so nothing loads `.env`
 * for us and each gated lane loads it itself. As with the live lane, a missing
 * key is a *skip*, never a failure — `pnpm test` must stay credential-free.
 * `pnpm test:db` is the lane that turns the same absence into a hard error, via
 * its own guard in `package.json`; without that guard the `skipIf` below would
 * make an empty run indistinguishable from a passing one.
 */

import { fileURLToPath } from "node:url";

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
  const databaseName = url.split("/").pop()?.split("?")[0] ?? "";
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL names database "${databaseName}", which does not end in "_test". Refusing to run: these tests truncate llm_usage and their fixture rows are counted as real spend by the budget ceiling.`,
    );
  }
}

/** The scratch-database URL, or `undefined` when the lane should skip. */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() || undefined;

if (testDatabaseUrl) assertNotTheAppDatabase(testDatabaseUrl);
