import { describe, expect, it } from "vitest";
import {
  type GmailMessagePart,
  decodeBase64Url,
  decodePartText,
  decodeQuotedPrintable,
  findBodyPart,
  readHeader,
} from "../mime";
import attachmentOnlyMessage from "./fixtures/attachment-only-message.json";
import multipartAlternativeMessage from "./fixtures/multipart-alternative-message.json";
import multipartMixedWithAttachment from "./fixtures/multipart-mixed-with-attachment.json";

describe("decodeBase64Url", () => {
  it("decodes standard base64url output", () => {
    const encoded = Buffer.from("hello world").toString("base64url");
    expect(decodeBase64Url(encoded).toString("utf-8")).toBe("hello world");
  });

  it("decodes padding-less input using the -/_ alphabet", () => {
    // "any carnal pleasure." base64-encodes to "YW55IGNhcm5hbCBwbGVhc3VyZS4=" —
    // base64url strips the trailing "=" padding and swaps +//.
    const encoded = Buffer.from("any carnal pleasure.").toString("base64url");
    expect(encoded.endsWith("=")).toBe(false);
    expect(decodeBase64Url(encoded).toString("utf-8")).toBe("any carnal pleasure.");
  });
});

describe("decodeQuotedPrintable", () => {
  it("decodes =XX hex escapes, including a multi-byte UTF-8 sequence spread across several escapes", () => {
    const raw = Buffer.from("2+2=3D4, and here is a euro sign: =E2=82=AC", "ascii");
    const decoded = decodeQuotedPrintable(raw);
    expect(decoded.toString("utf-8")).toBe("2+2=4, and here is a euro sign: €");
  });

  it("removes a soft line break (=\\n), joining the two source lines with no newline", () => {
    const raw = Buffer.from("first part=\nsecond part", "ascii");
    expect(decodeQuotedPrintable(raw).toString("utf-8")).toBe("first partsecond part");
  });

  it("removes a soft line break written as =\\r\\n", () => {
    const raw = Buffer.from("first part=\r\nsecond part", "ascii");
    expect(decodeQuotedPrintable(raw).toString("utf-8")).toBe("first partsecond part");
  });
});

describe("decodePartText", () => {
  it("decodes a declared non-UTF-8 charset (ISO-8859-1) correctly", () => {
    const latin1Bytes = Buffer.from("Café con leche, mañana a las diez.", "latin1");
    const text = decodePartText(latin1Bytes, "text/plain; charset=ISO-8859-1");
    expect(text).toBe("Café con leche, mañana a las diez.");
  });

  it("falls back to UTF-8 (never throws) for a missing charset=", () => {
    const utf8Bytes = Buffer.from("plain ascii body", "utf-8");
    expect(() => decodePartText(utf8Bytes, "text/plain")).not.toThrow();
    expect(decodePartText(utf8Bytes, "text/plain")).toBe("plain ascii body");
  });

  it("falls back to UTF-8 (never throws) for a bogus, unrecognized charset= value", () => {
    const utf8Bytes = Buffer.from("plain ascii body", "utf-8");
    expect(() => decodePartText(utf8Bytes, "text/plain; charset=totally-bogus-xyz")).not.toThrow();
    expect(decodePartText(utf8Bytes, "text/plain; charset=totally-bogus-xyz")).toBe(
      "plain ascii body",
    );
  });

  it("falls back to UTF-8 for an undefined Content-Type entirely", () => {
    const utf8Bytes = Buffer.from("no content-type at all", "utf-8");
    expect(decodePartText(utf8Bytes, undefined)).toBe("no content-type at all");
  });
});

describe("findBodyPart", () => {
  it("prefers text/plain over text/html in a multipart/alternative", () => {
    const part = findBodyPart(multipartAlternativeMessage.payload as GmailMessagePart);
    expect(part?.mimeType).toBe("text/plain");
  });

  it("descends a nested multipart/mixed to find text/plain alongside an attachment part", () => {
    const part = findBodyPart(multipartMixedWithAttachment.payload as GmailMessagePart);
    expect(part?.mimeType).toBe("text/plain");
  });

  it("falls back to text/html when no plain part exists", () => {
    const htmlOnlyPayload: GmailMessagePart = {
      mimeType: "text/html",
      body: { data: Buffer.from("<p>hi</p>").toString("base64url") },
    };
    const part = findBodyPart(htmlOnlyPayload);
    expect(part?.mimeType).toBe("text/html");
  });

  it("returns undefined for an attachment-only payload", () => {
    const part = findBodyPart(attachmentOnlyMessage.payload as GmailMessagePart);
    expect(part).toBeUndefined();
  });

  it("returns undefined for an undefined payload", () => {
    expect(findBodyPart(undefined)).toBeUndefined();
  });
});

describe("readHeader", () => {
  const headers = [
    { name: "From", value: "sender@example.com" },
    { name: "Content-Type", value: "text/plain; charset=UTF-8" },
  ];

  it("is case-insensitive", () => {
    expect(readHeader(headers, "from")).toBe("sender@example.com");
    expect(readHeader(headers, "FROM")).toBe("sender@example.com");
    expect(readHeader(headers, "content-type")).toBe("text/plain; charset=UTF-8");
  });

  it("returns undefined for a header that is not present", () => {
    expect(readHeader(headers, "Subject")).toBeUndefined();
  });

  it("returns undefined for undefined headers", () => {
    expect(readHeader(undefined, "From")).toBeUndefined();
  });
});
