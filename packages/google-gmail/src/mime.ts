/**
 * Our own, narrow MIME parsing over the Gmail API's `payload` shape — no
 * library (settled decision 20, same posture as `gmail-client.ts`'s own
 * fetch wrapper). Small, individually-named, individually-testable
 * functions; nothing here summarizes or calls an LLM (settled decision 5).
 */

export interface GmailMessageHeader {
  name?: string;
  value?: string;
}

export interface GmailMessagePartBody {
  size?: number;
  /** Base64url-encoded raw bytes of this part — absent for an attachment part fetched by reference (`attachmentId`), which this phase never resolves. */
  data?: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

/**
 * Gmail's own base64url alphabet (`-`/`_` instead of `+`/`/`, no required
 * padding) — `Buffer`'s `"base64"` decoder tolerates both the substituted
 * characters once swapped back and the missing padding.
 */
export function decodeBase64Url(data: string): Buffer {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

/**
 * Decodes quoted-printable at the byte level, not the string level — a
 * multi-byte UTF-8 (or other charset) sequence is spread across several
 * `=XX` escapes (e.g. `=E2=82=AC` for `€`), so decoding must reassemble raw
 * bytes before `decodePartText` applies the charset, not after. A soft line
 * break (`=\r\n` or `=\n`) is removed entirely — it exists only to wrap the
 * encoded line for transport and must not become a real newline.
 */
export function decodeQuotedPrintable(bytes: Uint8Array): Buffer {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === undefined) break;
    if (byte === 0x3d /* "=" */) {
      const next1 = bytes[i + 1];
      const next2 = bytes[i + 2];
      if (next1 === 0x0d && next2 === 0x0a) {
        i += 2; // soft break "=\r\n"
        continue;
      }
      if (next1 === 0x0a) {
        i += 1; // soft break "=\n"
        continue;
      }
      if (next1 !== undefined && next2 !== undefined) {
        const hex = String.fromCharCode(next1, next2);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(Number.parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
    }
    out.push(byte);
  }
  return Buffer.from(out);
}

function extractCharset(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1];
}

/**
 * The charset-aware decode step. An absent, unrecognized, or
 * `TextDecoder`-rejected `charset=` value **falls back to UTF-8** rather
 * than throwing — a malformed declaration degrades to possibly-mangled
 * text, never a tool error. `decodePartText` must never throw.
 */
export function decodePartText(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = extractCharset(contentType) ?? "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/**
 * Reads and fully decodes one message part's body text: base64url decode,
 * then `decodeQuotedPrintable` when the part's own `Content-Transfer-
 * Encoding` header says so, then the charset-aware `decodePartText` off the
 * part's own `Content-Type` header. A part with no `body.data` (an
 * attachment referenced only by `attachmentId`, which this phase never
 * resolves) decodes to `""` rather than throwing.
 */
export function decodePart(part: GmailMessagePart): string {
  if (part.body?.data === undefined) return "";
  const contentType = readHeader(part.headers, "Content-Type");
  const transferEncoding = readHeader(part.headers, "Content-Transfer-Encoding");
  const raw = decodeBase64Url(part.body.data);
  const bytes =
    transferEncoding?.trim().toLowerCase() === "quoted-printable"
      ? decodeQuotedPrintable(raw)
      : raw;
  return decodePartText(bytes, contentType);
}

function findPartByMimeType(
  part: GmailMessagePart,
  mimeType: string,
): GmailMessagePart | undefined {
  if (part.mimeType === mimeType && part.body?.data !== undefined) return part;
  for (const child of part.parts ?? []) {
    const found = findPartByMimeType(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/**
 * Recursively walks `payload.parts`, preferring `text/plain` over
 * `text/html` **at every level** — a full depth-first search for a
 * `text/plain` part anywhere in the tree runs before an `text/html` part
 * anywhere is even considered, so a nested `text/html` can never win over a
 * `text/plain` sitting deeper. Falls back to the deepest `text/html` when no
 * plain part exists anywhere, and returns `undefined` for an attachment-only
 * payload (no readable text part at all).
 */
export function findBodyPart(payload: GmailMessagePart | undefined): GmailMessagePart | undefined {
  if (payload === undefined) return undefined;
  return findPartByMimeType(payload, "text/plain") ?? findPartByMimeType(payload, "text/html");
}

/** Case-insensitive header lookup — Gmail's own header names are inconsistently cased across senders. */
export function readHeader(
  headers: GmailMessageHeader[] | undefined,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const header of headers ?? []) {
    if (header.name?.toLowerCase() === target) return header.value;
  }
  return undefined;
}
