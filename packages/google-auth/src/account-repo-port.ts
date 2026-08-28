import { type GoogleAccount, googleAccountSchema } from "@hermes/core";

/**
 * The row shape itself lives in `@hermes/core` (`google-types.ts`) and is
 * re-exported both here and by `@hermes/store`, exactly as `LlmUsageEntry`
 * is shared between `@hermes/llm` and `@hermes/store`: the two sides of the
 * persistence boundary compile against one declaration without either
 * importing the other.
 */
export { type GoogleAccount, googleAccountSchema };

/**
 * The injected persistence port — `packages/google-auth` never imports
 * `@hermes/store` directly, the same boundary `packages/agent`'s `ThreadRepo`
 * and `packages/llm`'s `LlmUsageRepo` already follow.
 * `apps/hermes/src/store/build-google-account-repo.ts` binds this to
 * `@hermes/store`'s `getAccount`/`upsertAccount`/`deleteAccount` free
 * functions.
 */
export interface GoogleAccountRepo {
  getAccount(channel: string, channelUserId: string): Promise<GoogleAccount | undefined>;
  upsertAccount(account: GoogleAccount): Promise<void>;
  deleteAccount(channel: string, channelUserId: string): Promise<void>;
}
