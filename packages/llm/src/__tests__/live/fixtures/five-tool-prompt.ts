/**
 * Test-local fixture data for the ROADMAP §8 tool-calling check: five small,
 * plausible JSON-Schema tool definitions plus one fixed user prompt, used
 * identically against both live provider profiles.
 *
 * This is **not** a tool registry. `packages/agent` (2c) owns the real one;
 * it does not exist yet and must not be created here. Nothing outside
 * `src/__tests__` imports this file.
 *
 * The five tools deliberately span the shapes a real registry will hold: two
 * thin single-argument tools, one multi-argument tool with a numeric field,
 * one tool with an optional argument, and one fat tool with an array and a
 * nested object. The prompt has exactly one defensible answer
 * (`convert_currency`) so accuracy is a fixed assertion, not a subjective
 * read — and that tool's schema mixes a number with two strings, so a
 * provider that emits sloppy tool-call JSON shows up as a schema violation
 * rather than passing silently.
 */

import type { CompletionRequest, ToolDefinition } from "../../../port";

export const FIVE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_current_time",
    description: "Get the current wall-clock time in a given IANA timezone.",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone name, e.g. 'Europe/Madrid'." },
      },
      required: ["timezone"],
      additionalProperties: false,
    },
  },
  {
    name: "echo",
    description: "Repeat the given text back to the user verbatim.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The exact text to repeat back." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "convert_currency",
    description:
      "Convert an amount of money from one currency to another using the current exchange rate.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "The amount of money to convert." },
        from: { type: "string", description: "ISO 4217 code of the source currency, e.g. 'USD'." },
        to: { type: "string", description: "ISO 4217 code of the target currency, e.g. 'JPY'." },
      },
      required: ["amount", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "search_web",
    description: "Search the public web and return a list of result titles and URLs.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: {
          type: "integer",
          description: "How many results to return. Defaults to 5.",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "create_calendar_event",
    description: "Create an event on the user's calendar and invite the given attendees.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title." },
        start_iso: { type: "string", description: "Start time as an ISO-8601 timestamp." },
        end_iso: { type: "string", description: "End time as an ISO-8601 timestamp." },
        attendees: {
          type: "array",
          description: "Email addresses to invite.",
          items: { type: "string" },
        },
        location: { type: "string", description: "Optional physical or virtual location." },
        reminder: {
          type: "object",
          description: "How and when to remind the attendees.",
          properties: {
            minutes_before: { type: "integer", minimum: 0 },
            method: { type: "string", enum: ["email", "push"] },
          },
          required: ["minutes_before", "method"],
          additionalProperties: false,
        },
      },
      required: ["title", "start_iso", "end_iso", "attendees"],
      additionalProperties: false,
    },
  },
];

/**
 * Fixed system prompt. Kept short and stable: it is part of the request's
 * cacheable prefix and must be byte-identical across all 20 trials so the
 * two providers are compared on the same input.
 */
export const FIVE_TOOL_SYSTEM_PROMPT =
  "You are a tool-using assistant. When the user's request is served by one of " +
  "the provided tools, answer with a tool call rather than prose. Call exactly " +
  "one tool.";

/**
 * The one fixed user prompt. Chosen so that exactly one of the five tools is
 * defensible: it names an amount and two currencies, and matches no other
 * tool's description.
 */
export const FIVE_TOOL_USER_PROMPT =
  "I'm about to pay a Japanese supplier. Convert 250 US dollars to Japanese yen for me.";

/** The single defensible answer to `FIVE_TOOL_USER_PROMPT`. The accuracy assertion target. */
export const EXPECTED_TOOL_NAME = "convert_currency";

/**
 * The one request shape both lanes send: the live check builds it per ladder
 * rung, the offline replay rebuilds it from each recorded attempt. Only `model`
 * and `maxTokens` ever vary — everything else must stay byte-identical, or the
 * replay would score bodies that were produced from a different prompt.
 */
export function buildFiveToolRequest(model: string, maxTokens: number): CompletionRequest {
  return {
    model,
    system: FIVE_TOOL_SYSTEM_PROMPT,
    messages: [{ role: "user", content: FIVE_TOOL_USER_PROMPT }],
    tools: FIVE_TOOL_DEFINITIONS,
    maxTokens,
  };
}
