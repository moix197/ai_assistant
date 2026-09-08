import { describe, expect, it } from "vitest";
import { buildMimeMessage } from "../build-mime-message";
import { decodeBase64Url } from "../mime";

/** Decodes the `raw` field back to its RFC 2822 text and splits it into its header block and body block, mirroring how a real MIME parser would. */
function decodeMessage(raw: string): { headerLines: string[]; bodyText: string } {
  const text = decodeBase64Url(raw).toString("utf-8");
  const separatorIndex = text.indexOf("\r\n\r\n");
  const headerBlock = text.slice(0, separatorIndex);
  const bodyBlock = text.slice(separatorIndex + 4);
  const bodyText = Buffer.from(bodyBlock.split("\r\n").join(""), "base64").toString("utf-8");
  return { headerLines: headerBlock.split("\r\n"), bodyText };
}

/** Decodes one `Subject: =?UTF-8?B?<base64>?=` header value back to plain text — the round-trip check the accented-subject test needs. */
function decodeEncodedWord(headerValue: string): string {
  const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(headerValue);
  const encoded = match?.[1];
  if (encoded === undefined) throw new Error(`not an RFC 2047 encoded-word: ${headerValue}`);
  return Buffer.from(encoded, "base64").toString("utf-8");
}

describe("buildMimeMessage", () => {
  it("an ASCII subject passes through unencoded", () => {
    const raw = buildMimeMessage({
      from: "me@example.com",
      to: "sarah@example.com",
      subject: "Q3 budget",
      body: "Sounds good.",
    });

    const { headerLines } = decodeMessage(raw);
    expect(headerLines).toContain("Subject: Q3 budget");
  });

  it("a non-ASCII subject is RFC 2047 encoded and round-trips back to the original text", () => {
    const raw = buildMimeMessage({
      from: "me@example.com",
      to: "sarah@example.com",
      subject: "Re: Confirmación",
      body: "El viernes me sirve.",
    });

    const { headerLines } = decodeMessage(raw);
    const subjectLine = headerLines.find((line) => line.startsWith("Subject: "));
    expect(subjectLine).toBeDefined();
    const encodedValue = (subjectLine as string).slice("Subject: ".length);
    expect(encodedValue).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(decodeEncodedWord(encodedValue)).toBe("Re: Confirmación");
  });

  it("the body round-trips through base64/UTF-8, accents included", () => {
    const body = "El viernes me sirve, gracias por confirmar la reunión.";
    const raw = buildMimeMessage({
      from: "me@example.com",
      to: "sarah@example.com",
      subject: "Re: Confirmación",
      body,
    });

    const { bodyText } = decodeMessage(raw);
    expect(bodyText).toBe(body);
  });

  it("uses CRLF line endings throughout", () => {
    const raw = buildMimeMessage({
      from: "me@example.com",
      to: "sarah@example.com",
      subject: "Hello",
      body: "Hi there.",
    });

    const text = decodeBase64Url(raw).toString("utf-8");
    expect(text).toContain("\r\n");
    // No lone "\n" that isn't part of a "\r\n" pair.
    expect(/(?<!\r)\n/.test(text)).toBe(false);
  });

  it("includes In-Reply-To and References headers when supplied", () => {
    const raw = buildMimeMessage({
      from: "me@example.com",
      to: "sarah@example.com",
      subject: "Re: Confirmación",
      body: "El viernes me sirve.",
      inReplyTo: "<msg-1@mail.gmail.com>",
      references: "<msg-1@mail.gmail.com>",
    });

    const { headerLines } = decodeMessage(raw);
    expect(headerLines).toContain("In-Reply-To: <msg-1@mail.gmail.com>");
    expect(headerLines).toContain("References: <msg-1@mail.gmail.com>");
  });

  it("omits In-Reply-To and References headers when not supplied", () => {
    const raw = buildMimeMessage({
      from: "me@example.com",
      to: "sarah@example.com",
      subject: "Hello",
      body: "Hi there.",
    });

    const { headerLines } = decodeMessage(raw);
    expect(headerLines.some((line) => line.startsWith("In-Reply-To:"))).toBe(false);
    expect(headerLines.some((line) => line.startsWith("References:"))).toBe(false);
  });

  it("neutralizes a header-injection attempt via the subject: a CRLF inside it never produces an extra header", () => {
    const raw = buildMimeMessage({
      from: "me@example.com",
      to: "sarah@example.com",
      subject: "Hello\r\nBcc: attacker@example.com",
      body: "Hi there.",
    });

    const { headerLines } = decodeMessage(raw);
    expect(headerLines.some((line) => line.toLowerCase().startsWith("bcc:"))).toBe(false);
    // Exactly the six fixed headers this composer always writes (no threading headers here).
    expect(headerLines).toHaveLength(6);
  });

  it("neutralizes a header-injection attempt via the body: a CRLF inside it never produces an extra header, and the original text is preserved", () => {
    const injected = "Hi there.\r\nBcc: attacker@example.com";
    const raw = buildMimeMessage({
      from: "me@example.com",
      to: "sarah@example.com",
      subject: "Hello",
      body: injected,
    });

    const { headerLines, bodyText } = decodeMessage(raw);
    expect(headerLines.some((line) => line.toLowerCase().startsWith("bcc:"))).toBe(false);
    expect(bodyText).toBe(injected);
  });
});
