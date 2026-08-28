import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePkcePair } from "../pkce";

const UNRESERVED_BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("generatePkcePair", () => {
  it("produces a verifier within RFC 7636's 43-128 char bound, from the unreserved alphabet", () => {
    const { verifier } = generatePkcePair();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(UNRESERVED_BASE64URL);
  });

  it("computes challenge as the base64url SHA-256 digest of verifier (RFC 7636 §4.2)", () => {
    const { verifier, challenge } = generatePkcePair();

    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("generates a fresh verifier each call", () => {
    const first = generatePkcePair();
    const second = generatePkcePair();

    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(second.challenge);
  });
});
