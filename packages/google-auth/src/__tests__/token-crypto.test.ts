import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenDecryptError, openToken, sealToken } from "../token-crypto";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

describe("token-crypto", () => {
  it("round-trips plaintext through seal/open", () => {
    const envelope = sealToken("super-secret-token", KEY);

    expect(openToken(envelope, KEY)).toBe("super-secret-token");
  });

  it("produces a different envelope each seal of the same plaintext (fresh IV)", () => {
    const first = sealToken("same-plaintext", KEY);
    const second = sealToken("same-plaintext", KEY);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });

  it("throws TokenDecryptError when a ciphertext byte is tampered", () => {
    const envelope = sealToken("super-secret-token", KEY);
    const ctBytes = Buffer.from(envelope.ct, "base64");
    ctBytes.writeUInt8(ctBytes.readUInt8(0) ^ 0xff, 0);
    const tampered = { ...envelope, ct: ctBytes.toString("base64") };

    expect(() => openToken(tampered, KEY)).toThrow(TokenDecryptError);
  });

  it("throws TokenDecryptError when the auth tag is tampered", () => {
    const envelope = sealToken("super-secret-token", KEY);
    const tagBytes = Buffer.from(envelope.tag, "base64");
    tagBytes.writeUInt8(tagBytes.readUInt8(0) ^ 0xff, 0);
    const tampered = { ...envelope, tag: tagBytes.toString("base64") };

    expect(() => openToken(tampered, KEY)).toThrow(TokenDecryptError);
  });

  it("throws TokenDecryptError, never garbage, when opened with the wrong key", () => {
    const envelope = sealToken("super-secret-token", KEY);

    expect(() => openToken(envelope, OTHER_KEY)).toThrow(TokenDecryptError);
  });
});
