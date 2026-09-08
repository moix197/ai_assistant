import { describe, expect, it } from "vitest";
import { htmlToText } from "../html-to-text";

describe("htmlToText", () => {
  it("removes <script> and <style> blocks along with their contents", () => {
    const html =
      "<html><head><style>.promo{color:red}</style></head><body><script>trackOpen();</script><p>Hello</p></body></html>";
    expect(htmlToText(html)).toBe("Hello");
  });

  it("converts block tags to newlines", () => {
    const html = "<p>First paragraph</p><p>Second paragraph</p><div>Third</div>";
    expect(htmlToText(html)).toBe("First paragraph\nSecond paragraph\nThird");
  });

  it("converts <br> to a newline", () => {
    expect(htmlToText("Line one<br>Line two<br/>Line three")).toBe(
      "Line one\nLine two\nLine three",
    );
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToText("Save 20% &amp; free shipping")).toBe("Save 20% & free shipping");
    expect(htmlToText("A&#160;B")).toBe("A B");
    expect(htmlToText("caf&#xe9;")).toBe("café");
  });

  it("strips remaining tags not otherwise handled", () => {
    expect(htmlToText("<span>Hi</span> <b>there</b>")).toBe("Hi there");
  });

  it("collapses 3+ blank lines to one", () => {
    const html = "<p>One</p><p></p><p></p><p></p><p>Two</p>";
    const result = htmlToText(html);
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toBe("One\n\nTwo");
  });

  it("passes plain-text input through unchanged", () => {
    const plain = "Just a plain sentence with no markup at all.";
    expect(htmlToText(plain)).toBe(plain);
  });
});
