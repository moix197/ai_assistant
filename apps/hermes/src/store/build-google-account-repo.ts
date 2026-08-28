import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { type Pool, deleteAccount, getAccount, upsertAccount } from "@hermes/store";

/**
 * Wires `@hermes/google-auth`'s injected `GoogleAccountRepo` port to
 * `@hermes/store`'s real Postgres-backed functions — the same shape
 * `build-thread-repo.ts` uses for `ThreadRepo`.
 */
export function buildGoogleAccountRepo(pool: Pool): GoogleAccountRepo {
  return {
    getAccount: (channel: string, channelUserId: string) =>
      getAccount(pool, channel, channelUserId),
    upsertAccount: (account: GoogleAccount) => upsertAccount(pool, account),
    deleteAccount: (channel: string, channelUserId: string) =>
      deleteAccount(pool, channel, channelUserId),
  };
}
