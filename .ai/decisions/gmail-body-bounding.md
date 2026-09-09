# Gmail body bounding: own MIME/HTML/quote-strip pipeline, capped after stripping, kept package-local

**Decision:** `@hermes/google-gmail` reads message bodies through four
separately-testable pure functions it owns outright — `mime.ts`'s
`decodePart` (base64url + quoted-printable + charset-aware decode),
`html-to-text.ts`'s `htmlToText`, `strip-quoted-reply.ts`'s
`stripQuotedReply`, and `truncate.ts`'s per-message char cap — composed in
that fixed order inside `gmail-read-thread.ts`'s handler, plus a
message-count/size pre-cap (`truncateBySize`) applied to the thread's message
list *before* any body is fetched at all. No mail-parsing library is used.

**Why:**

- **No mail library clears CLAUDE.md's two bars.** MIME parsing,
  HTML-to-text and quoted-reply stripping are all well-trodden problems, but
  none of the available packages is a load-bearing, low-risk fit: pulling in
  a general MIME parser to cover the narrow slice of RFC 2822/Gmail API
  `payload` shapes this project actually receives would import far more
  surface (attachments, S/MIME, calendar invites, arbitrary charset tables)
  than it uses, for a job the project can write, test against real fixtures,
  and fully own. Same posture as `gmail-client.ts`'s own `fetch` wrapper
  (settled decision 20) and `sheets-client.ts` before it — this codebase
  writes its own thin client over documented REST/MIME shapes rather than
  adopt a general-purpose SDK for a handful of operations.
- **Pipeline order is load-bearing: decode → HTML→text → strip quotes →
  cap, never cap first.** Capping before HTML→text would spend the entire
  character budget on markup tags and CSS, leaving little or no visible text
  in the capped result — a message that clearly has readable content would
  come back looking truncated to nothing. Stripping quotes before capping
  means the cap only ever eats into the part of the message a human actually
  wrote, not the quoted history underneath it; capping first would sometimes
  cut off the new content and keep the boilerplate quote instead.
- **Two caps for two different things, not one.** `truncateBySize`'s
  message-count/size cap (`MAX_THREAD_MESSAGES = 10`) runs *before* any
  `getMessageFull` call, deciding which messages are worth fetching at all —
  a 100-message thread issues at most 10 body fetches, not 100. The
  per-message char cap (`MAX_BODY_CHARS_PER_MESSAGE = 2_000`) runs *after*
  the body pipeline, bounding what one already-fetched message contributes.
  Conflating them (e.g. one global char budget applied post-hoc across all
  messages) would make the network cost of a large thread unbounded even
  though the returned text stays bounded.
- **Truncation fields are additive**, mirroring
  `bounded-tool-results.md`'s Sheets contract exactly: `bodyTruncated` per
  message and `truncated`/`returnedMessages`/`totalMessages`/`note` at the
  thread level exist only when something was actually cut, so an
  untruncated `gmail_read_thread` result is byte-identical to the shape that
  shipped before any of this existed.
- **The deliberate `truncate.ts`/`canonical-args.ts` duplication with
  `@hermes/google-sheets` is intentional, not an oversight.** Gmail's
  `truncateBySize` mirrors Sheets' contract (accumulate in order, stop
  before exceeding a cap, always keep at least one item) byte-for-byte in
  shape but not in caps (message-count/chars vs. cells/chars) or in the item
  being measured; `canonicalizeArgs`/`computeDedupeKey` mirror Sheets'
  dedupe-key hashing the same way. Both stay package-local rather than
  moving to `@hermes/core`, following the same **third-caller promotion
  trigger** [http-retry-helper-extraction](http-retry-helper-extraction.md)
  already set for `withHttpRetry`: two independent, slightly-different
  implementations are cheaper to keep than to force into one shared
  abstraction prematurely; a real third caller is what would justify finding
  the actual shared shape underneath both.

**Rejected:**

- *A mail-parsing dependency* (e.g. a full MIME/email library) — see above;
  a worse, less-tested copy of what this package already needs is not what
  such a library would buy here, and the surface it pulls in vastly exceeds
  what a Gmail API `payload` tree actually requires.
- *Promoting `truncate.ts`/`canonical-args.ts` to `@hermes/core` at two
  callers* — the third-caller trigger isn't met yet; forcing a shared
  abstraction over two call sites with different caps and measured units
  would guess at the shape a real third caller should actually determine.
- *LLM summarization inside a tool* — would make a read tool's output
  non-deterministic and cost an extra model call per read, for a job a
  cheap, deterministic client-side cap already does adequately.
- *A dedicated `summarize_inbox` tool* — adds a second, overlapping read
  surface instead of making the existing three read tools' results legible
  on their own; nothing in this plan's scope needs a fourth read tool.

**Constraints it creates:**

- A new Gmail read path that returns message body text must go through this
  same decode → HTML→text → strip-quotes → cap order; capping any earlier
  in the pipeline is wrong for the reasons above.
- Do not promote `truncate.ts` or `canonical-args.ts` out of this package
  until a genuine third caller (beyond Sheets and Gmail) needs the same
  shape — see [http-retry-helper-extraction](http-retry-helper-extraction.md)
  for the precedent this follows.
- Any new truncation field must stay additive (conditional spread), matching
  [bounded-tool-results](bounded-tool-results.md)'s contract.
