/**
 * Structurally matches zod's `ZodType<T>` (specifically `safeParse`'s return
 * shape) without this package taking `zod` on as a dependency — `store` has
 * no other reason to import the library itself, and every real schema
 * passed in (`@hermes/core`'s `messagesArraySchema`, Phase 2's
 * `GoogleAccount` schema) already satisfies this shape structurally.
 */
export interface ValidatableSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

/** Matches `03-agent-core`'s settled posture for `tool.call`'s `error` field (see `packages/agent/src/loop.ts`). */
const VALIDATION_ERROR_MAX_CHARS = 500;

function truncateValidationError(message: string): string {
  return message.length > VALIDATION_ERROR_MAX_CHARS
    ? message.slice(0, VALIDATION_ERROR_MAX_CHARS)
    : message;
}

/**
 * Validates a jsonb column's already-parsed value against `schema`, failing
 * closed (per ROADMAP invariant 7) rather than casting: a hand-corrupted row
 * (e.g. a manual `psql` edit) throws here instead of being silently replayed
 * to whatever assumed its shape — a `Message[]` fed straight into
 * `trimHistory`/`converse`, for one. Deliberately **generic**: this helper
 * takes any schema matching `ValidatableSchema`, so `thread-repo.ts`'s
 * `Message[]` validation and Phase 2's `GoogleAccountRepo` validation share
 * one implementation, each against its own schema-first type, rather than
 * one idiom per package.
 *
 * The thrown error names `context` (e.g. `"threads.messages"`) so a failure
 * is traceable to a table/column without a stack trace, but truncates the
 * schema's error text itself to `VALIDATION_ERROR_MAX_CHARS` — a corrupted
 * row's full content must not leak into logs indiscriminately, the same
 * posture `tool.call`'s `error` field already applies.
 */
export function parseValidatedJson<T>(
  schema: ValidatableSchema<T>,
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new Error(
    `${context}: failed schema validation: ${truncateValidationError(result.error.message)}`,
  );
}
