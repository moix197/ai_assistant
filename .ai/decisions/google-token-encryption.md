# Google tokens at rest: AES-256-GCM in a self-describing envelope, key validated at boot

**Decision:** `packages/google-auth/src/token-crypto.ts` seals a Google
account's access and refresh tokens — serialized together as one JSON string
— into a single AES-256-GCM envelope `{ v: 1, iv, tag, ct }` (all base64),
using a fresh random 12-byte IV per seal. `TOKEN_ENCRYPTION_KEY` (32 random
bytes, base64) is validated by `packages/config`'s zod schema to decode to
exactly 32 bytes at boot, not at first token write. `packages/store` persists
`token_envelope` as an opaque `jsonb` column and never decrypts it —
`TOKEN_ENCRYPTION_KEY` never enters that package's config surface.

**Why:**

- **One envelope, not two.** `google-auth-library`'s token exchange returns
  an access token and a refresh token as plain data with no requirement that
  they be sealed separately — verified at execution time. One seal/open call
  is strictly simpler than two, costs no less protection (both tokens live
  behind the same key and the same row regardless), and keeps the migration's
  `token_envelope` column singular, matching `GoogleAccount`'s schema-first
  `tokenEnvelope: tokenEnvelopeSchema` field.
- **A tampered or wrong-key open throws, never returns garbage.** GCM's
  authentication tag makes this a property, not a policy: flipping one byte
  of `ct` or `tag` makes `decipher.final()` throw on tag mismatch, caught and
  re-raised as a typed `TokenDecryptError`. A wrong key produces the same
  failure. This is what lets Phase 4's refresh sweep treat a decrypt failure
  as "this account needs reconnecting," not as a token to blindly retry with.
- **The envelope is self-describing and versioned (`v: 1`) from day one.**
  A future two-key rotation or re-envelope scheme needs no migration to add a
  version field retroactively — it's already there, unread by anything today,
  costing nothing until it's needed.
- **The key is validated at boot with a named error, not discovered at first
  write weeks later.** `packages/config`'s schema decodes and length-checks
  `TOKEN_ENCRYPTION_KEY` (base64, exactly 32 bytes for AES-256) as part of
  `envSchema`, alongside the three-key all-or-none group
  (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`TOKEN_ENCRYPTION_KEY` —
  `checkFallbackAllOrNone`'s idiom, reused for a second group). A malformed
  key fails boot naming the key, instead of failing silently the first time
  someone runs `/connect google`.
- **`packages/store` never sees a plaintext token or the encryption key.**
  `GoogleAccountRepo`'s `upsertAccount`/`getAccount` pass `token_envelope`
  through as opaque JSON — persisted and read back byte-for-byte, validated
  on read via the same generic `parseValidatedJson` helper Phase 1 introduced
  for `Message`, pointed at `@hermes/google-auth`'s schema-first
  `googleAccountSchema`. This is what keeps a Postgres compromise from also
  being a plaintext-token leak: the ciphertext sits in the database, the key
  sits only in `packages/config`'s validated env, read only by
  `packages/google-auth`.
- **Key rotation is documented, not automated, this phase.** Rotate by
  generating a new `TOKEN_ENCRYPTION_KEY`, restarting — every existing row
  then fails to decrypt (`TokenDecryptError`), surfaces as "disconnected,"
  and the operator re-runs `/connect google` per account. A dual-key decrypt
  window or an automated rotation tool is a future card, not this one; the
  envelope's `v` field is what makes that addable later without another
  migration.

**Rejected:**

- *Sealing access and refresh tokens in two separate envelopes/columns* — no
  requirement forces it, and it would only double the seal/open surface for
  no additional protection.
- *A key derived from `DATABASE_URL` or another existing secret* — couples
  two unrelated secrets' lifecycles (rotating one would silently break the
  other) and gives the operator no independent rotation lever.
- *Decrypting lazily and caching plaintext in memory across calls* — nothing
  in this phase needs it (`whoami` never calls a live Google API this phase),
  and it would widen the window a process-memory dump exposes real tokens in.
- *Failing boot silently to a "Google disabled" state on a malformed key* —
  rejected in favor of a loud, named boot failure; a key that looks present
  but doesn't actually validate is a configuration bug, not a legitimate
  "Google features off" state (that's the all-or-none-unset case instead).

**Constraints it creates:**

- Any future code touching Google tokens must go through `sealToken`/
  `openToken` — no other code path in this codebase should construct or
  parse a `TokenEnvelope` by hand.
- `packages/store` must never gain a dependency that lets it decrypt
  `token_envelope` — the opacity is the whole point of keeping
  `TOKEN_ENCRYPTION_KEY` out of that package's config surface.
- A refresh coordinator (Phase 4) must re-seal both tokens together on every
  refresh, keeping the one-envelope invariant rather than drifting toward
  partial updates of a multi-field envelope.
