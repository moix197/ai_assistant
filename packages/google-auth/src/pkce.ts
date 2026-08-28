import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * PKCE (RFC 7636) S256 pair for the `/connect google` authorize request.
 * `randomBytes(32)` base64url-encodes to exactly 43 characters — inside the
 * spec's 43-128 length bound and entirely within its unreserved alphabet, so
 * no further trimming/padding is needed. `challenge` is the base64url SHA-256
 * digest of `verifier` (RFC 7636 §4.2), sent at authorize time; `verifier`
 * itself is sent only once, server-to-server, at code-exchange time.
 */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
