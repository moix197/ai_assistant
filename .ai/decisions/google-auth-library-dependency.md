# `google-auth-library` adopted as a dependency, narrowly, for OAuth2 + refresh only

**Decision:** `packages/google-auth` depends on `google-auth-library`
(`google-auth-library@^9`), used narrowly for its `OAuth2Client` —
generating the authorize URL, exchanging an authorization code for tokens,
and (Phase 4) refreshing an access token. Everything else in this phase's
Google surface — the scope registry, PKCE, the state-nonce pending-connection
store, AES-256-GCM token encryption, and persistence — is homemade, per
CLAUDE.md's "build our own by default" rule.

**Why:**

- **Load-bearing.** OAuth2 token exchange and refresh is an auth/token
  protocol — the exact category CLAUDE.md names as worth a dependency rather
  than a worse, less-tested homemade copy. `ROADMAP.md` §6 pre-approved this
  dependency for exactly this reason before this plan existed; this doc is
  the written justification CLAUDE.md still requires even for a
  pre-approved dependency.
- **Low-risk.** First-party from Google, the vendor whose service this
  package talks to — the strongest case CLAUDE.md's dependency bar names.
  Widely adopted, actively maintained, stable API for the narrow surface used
  here (`generateAuthUrl`, `getToken`).
- **Used narrowly, not as a framework.** Only the OAuth2 client is imported;
  no Gmail/Calendar/Sheets client, no `googleapis`-style generated surface.
  `packages/google-auth`'s own code — not the library — owns PKCE generation,
  the state nonce, the token envelope, and the scope registry, so swapping
  the OAuth client implementation later would touch one file
  (`oauth-client.ts`), not this package's public shape.

**Rejected:**

- *`googleapis`* — a generated SDK covering hundreds of endpoints this
  codebase will never call at the ~15-endpoint scale `ROADMAP.md` §6 names
  for the Gmail/Calendar/Sheets wrappers later phases add. Those future
  wrappers use `fetch` directly, per the same rejection `ROADMAP.md` already
  recorded for the LLM client's vendor-SDK question.
- *`express` (or any router package) for the OAuth callback route* — the
  existing `node:http` health server, made path/query-aware, is sufficient
  for one additional route; `ROADMAP.md` §6 already rejects `express` for "a
  handful of webhook routes," and this callback is exactly that shape.
- *Hand-rolling the OAuth2 code exchange over `fetch`* — technically
  possible, but reimplementing token-endpoint request signing, error-body
  parsing, and refresh-token handling ourselves is precisely the "worse,
  less-tested copy" CLAUDE.md's dependency bar warns against for a spec this
  deep, from a vendor whose own maintained client already gets highest
  first-party trust.

**Constraints it creates:**

- `apps/hermes/src/google/build-google-oauth-client.ts` is the one place
  allowed to import both `@hermes/config` and construct a `google-auth-library`
  client directly — the same `build-provider-profiles.ts` precedent
  (`config`'s flat env fields mapped into another package's construction
  shape). `packages/google-auth` itself never imports `@hermes/config`.
- Any future Gmail/Calendar/Sheets client stays a `fetch`-based wrapper using
  `google-auth-library`'s `OAuth2Client` only for the bearer token — not a
  reason to widen this dependency's usage toward `googleapis`.
