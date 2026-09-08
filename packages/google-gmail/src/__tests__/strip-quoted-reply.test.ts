import { describe, expect, it } from "vitest";
import { stripQuotedReply } from "../strip-quoted-reply";

describe("stripQuotedReply", () => {
  it("cuts at an English 'On … wrote:' attribution line", () => {
    const text =
      "Sounds good.\n\nOn Mon, Sep 1, 2026 at 9:00 AM, Sarah <sarah@x.com> wrote:\n> Can we sync?";
    expect(stripQuotedReply(text)).toBe("Sounds good.");
  });

  it("cuts at a Spanish 'El … escribió:' attribution line", () => {
    const text =
      "Perfecto, nos vemos.\n\nEl lunes 1 de septiembre de 2026, Sarah <sarah@x.com> escribió:\n> ¿Podemos sincronizar?";
    expect(stripQuotedReply(text)).toBe("Perfecto, nos vemos.");
  });

  it("cuts at a run of >-prefixed lines with no attribution line", () => {
    const text = "My reply here.\n> Original message line one\n> Original message line two";
    expect(stripQuotedReply(text)).toBe("My reply here.");
  });

  it("cuts nested quotes at the outermost (first) '>' boundary", () => {
    const text = [
      "Sounds good, see you at 3pm.",
      "",
      "On Thu, Sep 4, 2026 at 10:00 AM, Sarah <sarah@example.com> wrote:",
      "> Can we sync at 3pm Friday?",
      ">",
      "> On Wed, Sep 3, 2026 at 9:00 AM, Alex <alex@example.com> wrote:",
      ">> Works for me, what time?",
      ">>",
      ">> On Tue, Sep 2, 2026, Sarah wrote:",
      ">>> Let's plan the Friday sync.",
    ].join("\n");
    expect(stripQuotedReply(text)).toBe("Sounds good, see you at 3pm.");
  });

  it("cuts at a -----Original Message----- separator", () => {
    const text = "Here is my reply.\n\n-----Original Message-----\nFrom: Sarah\nSubject: Hi";
    expect(stripQuotedReply(text)).toBe("Here is my reply.");
  });

  it("cuts at a '--' signature separator", () => {
    const text = "Thanks for the update.\n--\nSarah\nSenior Engineer";
    expect(stripQuotedReply(text)).toBe("Thanks for the update.");
  });

  it("leaves a message with no quoting unchanged", () => {
    const text = "Just a plain reply with no quoted history at all.";
    expect(stripQuotedReply(text)).toBe(text);
  });

  it("never returns an empty string — a message whose very first line matches a quote boundary still returns something", () => {
    const text = "On Mon, Sep 1, 2026 at 9:00 AM, Sarah <sarah@x.com> wrote:\n> Can we sync?";
    const result = stripQuotedReply(text);
    expect(result).not.toBe("");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns the first non-empty paragraph when a leading blank line precedes the boundary-matching first paragraph", () => {
    const text =
      "On Mon, Sep 1, 2026 at 9:00 AM, Sarah <sarah@x.com> wrote:\n> Can we sync?\n\nSome unrelated trailing paragraph.";
    const result = stripQuotedReply(text);
    expect(result).not.toBe("");
    expect(result).toBe(
      "On Mon, Sep 1, 2026 at 9:00 AM, Sarah <sarah@x.com> wrote:\n> Can we sync?",
    );
  });

  it("returns '' for '' input — never manufactures content from nothing", () => {
    expect(stripQuotedReply("")).toBe("");
  });
});
