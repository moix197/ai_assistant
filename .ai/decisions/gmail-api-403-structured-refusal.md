# Gmail API-side 401/403: the first re-auth path, mapped to the scope gate's own refusal shape

**Decision:** `@hermes/google-gmail`'s `insufficient-scope.ts` maps a caught
`GmailApiError` with HTTP status 401 or 403 to a structured refusal —
`{ ok: false, reason: "insufficient_scope", scope, fix }` — the **same**
field shape `apps/hermes/src/agent/with-required-scopes.ts`'s
`withRequiredScopes` already returns for its pre-call `missing_scope` gate.
Every Gmail tool's `handler` (and, for the gated write tools, `prepare`)
catches its own Gmail API calls through this mapping; any other error type
still throws and propagates as a genuine fatal error. This is the first
place in the codebase an **API-side** 401/403 — as opposed to a pre-call
scope check — has a structured re-auth path at all; previously an API-side
401/403 from Sheets or Calendar had none, and would have surfaced as an
unhandled thrown error.

**Why:**

- **`withRequiredScopes` gates every call before a token is even fetched,
  but that check is a point-in-time read of what was granted at connect (or
  last refresh) time — it cannot see a scope revoked at Google afterward.**
  A user can revoke a granted scope from their Google Account's third-party
  access settings at any time, entirely outside this app's control; the
  next Gmail call after that revocation gets a 401/403 from Google itself,
  after the pre-call gate already passed. Defense in depth: the gate makes
  this unreachable in the common case, but a genuine 401/403 mid-call still
  needs a structured answer, not a throw that surfaces as an opaque failure
  to the model and the human.
- **The model never mints a consent URL.** The refusal's `fix` field is a
  plain instruction string (e.g. `"run /connect google gmail-send"`),
  supplied by the caller per-tool — never a URL, never a token, never
  anything the model could act on directly. Re-authorization stays a human
  action through the existing `/connect` command surface, consistent with
  the standing invariant (`google-oauth-flow.md`) that the agent never sees
  a credential and cannot escalate its own scopes.
- **One refusal vocabulary regardless of which check caught it.** Reusing
  `withRequiredScopes`'s exact `{ ok, reason, scope, fix }` shape means the
  model (and any prompt/response handling built around that shape) doesn't
  need a second refusal format to recognize — a 401/403 caught mid-call
  reads identically to a scope gate rejection caught before the call.
- **`scope`/`fix` are supplied by the caller, not looked up centrally.**
  `toInsufficientScopeResult(error, scope, fix)` takes both as arguments
  rather than resolving them from `@hermes/google-auth`, because this
  package never imports `google-auth` (the consumer-declares-its-port
  convention its `AccessTokenPort` also follows). Each tool hardcodes its
  own scope/fix pair (e.g. `gmail-send-draft.ts`'s own
  `GMAIL_SEND_SCOPE`/`GMAIL_SEND_FIX` constants, duplicated per tool rather
  than centralized) — the same posture as the scope string literals already
  declared in `TOOL_REQUIRED_SCOPES`.
- **Why a 403 must not disconnect the account, unlike refresh-time
  `invalid_grant`.** `google-token-refresh.md`'s classification only
  disconnects on an explicit `invalid_grant` from the token *refresh*
  endpoint — a credential Google has permanently invalidated. A 403 from a
  single Gmail *API* call is a different failure entirely: it can mean a
  specific scope was narrowed or revoked, a specific message/thread became
  inaccessible, or a transient permission edge case — none of which imply
  the whole account's refresh token is dead. Disconnecting on any Gmail
  403 would destroy a working Sheets or Calendar connection sharing the
  same `google_accounts` row over a failure scoped to one Gmail call; the
  structured refusal instead leaves the account connected and asks only for
  the narrower fix (re-run the relevant `/connect google <tier>`).

**Rejected:**

- *Treat any 401/403 as fatal, matching the pre-`10-...` posture for Sheets/
  Calendar* — the option this decision replaces; leaves the model and human
  with an opaque failure instead of an actionable "run /connect google
  gmail-send" fix.
- *Disconnect the account on a Gmail 403*, mirroring `invalid_grant`'s
  handling — conflates a scoped, call-level permission failure with a
  refresh-token-level one; would take down Sheets/Calendar access over a
  Gmail-only problem.
- *Have the model mint or surface a consent/re-auth URL* — breaks the
  standing invariant that only a human-run `/connect` command can grant
  scopes; the model only ever sees a plain-string `fix` instruction.
- *A centralized scope/fix lookup inside `insufficient-scope.ts` keyed by
  tool name* — would require this package to know either the scope registry
  (`@hermes/google-auth`) or its own tool names in one place, breaking the
  consumer-declares-its-port boundary for no real gain over each tool
  hardcoding its own two constants.

**Constraints it creates:**

- A new Gmail tool that calls the Gmail API must catch its own calls through
  `toInsufficientScopeResult`, supplying its own hardcoded `scope`/`fix`
  pair, rather than letting a 401/403 propagate as an unhandled throw.
- The `Google OAuth + token lifecycle` cross-cutting row's prior framing —
  that an API-side 401/403 had no re-auth path — no longer holds for Gmail;
  a future Sheets/Calendar equivalent should follow this same mapping
  rather than reintroduce the old throw-and-surface-opaquely behavior.
- Do not fold a Gmail 403 into the refresh-failure classification
  (`invalid_grant`-only disconnect) in `google-token-refresh.md` — the two
  failure classes stay handled in different places for the reasons above.
