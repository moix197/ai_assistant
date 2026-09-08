/**
 * Deliberately dumb and deterministic HTML→text extraction for a model, not
 * a renderer — no library (settled decision 20). Order is load-bearing:
 * strip `<script>`/`<style>` blocks (contents included) before stripping
 * tags generally, so their contents never leak into the output; convert
 * block-level closing tags to newlines before the generic tag strip, so
 * paragraph/line structure survives; decode entities last, so a decoded
 * `&lt;` never gets re-stripped as a tag.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return (
    text
      .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
      .replace(
        /&([a-zA-Z]+);/g,
        (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
      )
      // A non-breaking space, however it was spelled (&nbsp;, &#160;, &#xA0;),
      // reads as a plain space to a model — this is text extraction, not a
      // renderer that needs to preserve the no-wrap hint.
      .replace(/ /g, " ")
  );
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = collapseBlankLines(text);
  return text.trim();
}
