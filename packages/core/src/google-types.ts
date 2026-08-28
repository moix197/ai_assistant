/**
 * The persisted shape of a connected Google account. Owned by `@hermes/core`
 * for exactly the reason `LlmUsageEntry` is: `@hermes/store` writes the row
 * and `@hermes/google-auth` consumes it, so leaving the shape in either one
 * would make the other import a sibling package. Both re-export these from
 * here instead, and a field added on one side can't silently fail to persist
 * on the other.
 *
 * Schema-first, the idiom `Message` uses: a `z.object` with the TS type
 * derived via `z.infer` rather than hand-written. That is what lets
 * `@hermes/store`'s generic `parseValidatedJson` (`validate-row.ts`)
 * validate a `google_accounts` row against the exact shape the rest of the
 * codebase compiles against, with no second, hand-synced schema to drift.
 */
import { z } from "zod";

/**
 * A sealed token, opaque to every caller except `@hermes/google-auth`'s
 * `token-crypto.ts` — `@hermes/store` persists it as-is (`jsonb`) and never
 * decrypts it. `v` is carried so a future key-rotation/re-envelope scheme
 * needs no migration to add it. The *schema* lives here rather than beside
 * `sealToken`/`openToken` only because `googleAccountSchema` below embeds it;
 * the crypto that produces and opens an envelope stays in
 * `@hermes/google-auth`, which re-exports this type.
 */
export const tokenEnvelopeSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
});
export type TokenEnvelope = z.infer<typeof tokenEnvelopeSchema>;

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
