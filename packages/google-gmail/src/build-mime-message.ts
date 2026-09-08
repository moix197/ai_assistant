/**
 * Our own RFC 2822 message composer — no library (settled decision 20, same
 * posture as `gmail-client.ts`'s own fetch wrapper and `mime.ts`'s own
 * parser). This is the load-bearing safety piece of `gmail_draft_reply`
 * (`.ai/decisions/tool-prepare-hook.md`): `buildMimeMessage` is called once,
 * inside `prepare`, and its output is threaded verbatim to the handler on
 * `ctx.plan.raw` — never recomposed. "The human approved exactly these
 * bytes" is true because there is exactly one place these bytes are ever
 * produced.
 */

const BODY_LINE_WRAP = 76;

export interface BuildMimeMessageInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** The `Message-ID` of the message being replied to, when known. */
  inReplyTo?: string;
  /** The `References` header value, when known — this phase always sets it equal to `inReplyTo` (a single id), since the metadata this tool reads carries no fuller reference chain. */
  references?: string;
}

/**
 * Header-injection defense: a raw `\r`/`\n` inside a header value could
 * otherwise terminate the header line early and let attacker-controlled text
 * (e.g. a `\r\nBcc: ...` fragment smuggled into a subject) start a new
 * header. Every header value this module writes passes through here first —
 * collapsing any CR/LF run to a single space rather than stripping it
 * silently, so the value stays readable instead of running words together.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ");
}

/** `true` for any value RFC 2047 encoding is required for — anything outside the 7-bit ASCII range, which is the default case for Spanish text (accents), not an edge case. */
function needsEncoding(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — flags any byte outside 7-bit ASCII, control characters included.
  return /[^\x00-\x7F]/.test(value);
}

/**
 * RFC 2047 `encoded-word` form (`=?UTF-8?B?<base64>?=`) for a header value
 * containing non-ASCII text — Spanish subjects with accents are the default
 * case this exists for, not an edge case. Sanitizes for header injection
 * first, then encodes only when needed so a plain ASCII subject stays
 * human-readable in the raw message.
 */
function encodeHeaderWord(value: string): string {
  const sanitized = sanitizeHeaderValue(value);
  if (!needsEncoding(sanitized)) return sanitized;
  const base64 = Buffer.from(sanitized, "utf-8").toString("base64");
  return `=?UTF-8?B?${base64}?=`;
}

function formatHeaderLine(name: string, value: string): string {
  return `${name}: ${sanitizeHeaderValue(value)}`;
}

/**
 * Base64-encodes the body as UTF-8 bytes and wraps it at `BODY_LINE_WRAP`
 * characters per line (RFC 2045's recommended max for base64 content),
 * CRLF-joined. This is what makes the body immune to header injection
 * regardless of its own content — a `\r\n` embedded in the body text is
 * itself base64-encoded away into alphanumeric bytes, never reaching the raw
 * message as a literal newline.
 */
function encodeBodyBase64(body: string): string {
  const base64 = Buffer.from(body, "utf-8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += BODY_LINE_WRAP) {
    lines.push(base64.slice(i, i + BODY_LINE_WRAP));
  }
  return lines.join("\r\n");
}

/** Gmail's own base64url alphabet for the `raw` field — the mirror of `mime.ts`'s `decodeBase64Url`, kept local here since no existing helper encodes (only decodes). */
function encodeBase64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Composes a full RFC 2822 message — CRLF line endings throughout, a
 * `text/plain; charset="UTF-8"` body under `Content-Transfer-Encoding:
 * base64`, and an RFC 2047-encoded `Subject` whenever it contains non-ASCII
 * text — then returns it base64url-encoded, the exact wire shape Gmail's
 * `users.drafts.create`/`users.drafts.update` `raw` field requires.
 * `inReplyTo`/`references` are only written when supplied, so a first
 * message in a thread never carries stray empty threading headers.
 */
export function buildMimeMessage(input: BuildMimeMessageInput): string {
  const { from, to, subject, body, inReplyTo, references } = input;

  const headerLines: string[] = [
    formatHeaderLine("From", from),
    formatHeaderLine("To", to),
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (inReplyTo !== undefined) headerLines.push(formatHeaderLine("In-Reply-To", inReplyTo));
  if (references !== undefined) headerLines.push(formatHeaderLine("References", references));

  const message = [...headerLines, "", encodeBodyBase64(body)].join("\r\n");
  return encodeBase64Url(Buffer.from(message, "utf-8"));
}
