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

/** The scratch-database URL, or `undefined` when the lane should skip. */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() || undefined;
