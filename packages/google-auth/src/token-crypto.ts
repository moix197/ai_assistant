import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { type TokenEnvelope, tokenEnvelopeSchema } from "@hermes/core";

/**
 * A sealed token, opaque to every caller except this file — `packages/store`
 * persists it as-is (`jsonb`) and never decrypts it (Dependencies & Risks:
 * "`packages/store` never sees a plaintext token"). Its schema lives in
 * `@hermes/core` because `googleAccountSchema` embeds it; only the crypto
 * that produces and opens an envelope belongs here.
 */
export { type TokenEnvelope, tokenEnvelopeSchema };

const ALGORITHM = "aes-256-gcm";
/** 96-bit IV, the size GCM is defined and optimized for. */
const IV_BYTES = 12;

/**
 * Thrown by `openToken` on any decrypt failure — a tampered `ct`/`tag`
 * (GCM auth tag mismatch) or the wrong key. Never returns corrupted
 * plaintext; the caller gets a typed error to react to (e.g. Phase 4 marking
 * the account disconnected), not silent garbage.
 */
export class TokenDecryptError extends Error {
  constructor(message = "token-crypto: failed to decrypt token envelope") {
    super(message);
    this.name = "TokenDecryptError";
  }
}

/** Seals `plaintext` with a fresh random IV — two seals of the same plaintext never produce the same envelope. */
export function sealToken(plaintext: string, key: Buffer): TokenEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

/** Opens `envelope` with `key`, or throws `TokenDecryptError` — never yields corrupted or partial plaintext. */
export function openToken(envelope: TokenEnvelope, key: Buffer): string {
  try {
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ct = Buffer.from(envelope.ct, "base64");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new TokenDecryptError();
  }
}
