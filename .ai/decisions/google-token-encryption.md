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
  The tag authenticates the *contents*, not which row the envelope came from
  — see **Deferred: GCM AAD binding** below for the limit of that guarantee.
- **The envelope is self-describing and versioned (`v: 1`) from day one.**
  A future two-key rotation or re-envelope scheme needs no migration to add a
  version field retroactively — it's already there, unread by anything today,
  costing nothing until it's needed. It is also what makes the deferred AAD
  binding addable later without a migration.
- **The key is validated at boot with a named error, not discovered at first
  write weeks later.** `packages/config`'s schema decodes and length-checks
  `TOKEN_ENCRYPTION_KEY` (base64 or base64url — both alphabets are what real
  generator commands emit, checked separately so a mixed-alphabet value is
  still rejected — decoding to exactly 32 bytes for AES-256) as part of
  `envSchema`, alongside the three-key all-or-none group
  (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`TOKEN_ENCRYPTION_KEY` —
  `checkFallbackAllOrNone`'s idiom, reused for a second group). A malformed
  key fails boot naming the key, instead of failing silently the first time
  someone runs `/connect google`.
- **`packages/store` never sees a plaintext token or the encryption key.**
  `GoogleAccountRepo`'s `upsertAccount`/`getAccount` pass `token_envelope`
  through as opaque JSON — persisted and read back byte-for-byte, validated
  on read via the same generic `parseValidatedJson` helper Phase 1 introduced
  for `Message`, pointed at `@hermes/core`'s schema-first
  `googleAccountSchema` (the shape and the `tokenEnvelopeSchema` it embeds
  live in `core` and are re-exported by both `store` and `google-auth`, so
  those two siblings never import each other; only `sealToken`/`openToken`
  stay in `google-auth`). This is what keeps a Postgres compromise from also
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

**Deferred (decided, not an oversight): GCM AAD binding.**

`sealToken`/`openToken` pass no additional authenticated data, so an envelope
is bound to nothing but the key. An envelope copied from one
`google_accounts` row into another therefore still decrypts, and that second
account would refresh with the first account's Google credentials. Binding
the seal to `channel:channelUserId` as AAD would make such a copy fail the
tag check.

Deliberately deferred, because:

- **Exploiting it already requires database *write* access.** An attacker
  who can `UPDATE google_accounts` has strictly easier paths available;
  AAD raises the floor on an attacker who is already past the interesting
  wall.
- **AAD changes the envelope format.** Every envelope stored today was
  sealed without AAD and would fail to open under an AAD-verifying
  `openToken` — every connected user is force-disconnected and must
  re-consent. That is the same one-time cost as a key rotation, paid here
  for a defense-in-depth improvement rather than a live threat.

**Revisit at the next envelope version bump** (`v: 2`): a rotation or
re-envelope scheme already pays the re-consent/re-seal cost, so AAD rides
along for free at that point. The `v` field exists precisely so that change
needs no migration.

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
