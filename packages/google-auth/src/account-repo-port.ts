import { z } from "zod";
import { tokenEnvelopeSchema } from "./token-crypto";

/**
 * Schema-first, matching the idiom `packages/core`'s `Message` uses
 * (Phase 1): a `z.object`, the TS type derived via `z.infer` rather than
 * hand-written. This is what lets `packages/store`'s generic
 * `parseValidatedJson` (`validate-row.ts`) validate a `google_accounts` row
 * against the exact shape this package (and `apps/hermes`) compile against,
 * with no second, hand-synced schema in `packages/store` to drift.
 */
export const googleAccountSchema = z.object({
  channel: z.string(),
  channelUserId: z.string(),
  chatId: z.string(),
  googleEmail: z.string(),
  scopes: z.array(z.string()),
  tokenEnvelope: tokenEnvelopeSchema,
  expiresAt: z.date(),
});
export type GoogleAccount = z.infer<typeof googleAccountSchema>;

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
