import { z } from "zod";

/** Env keys whose values must never appear unmasked in a log line. */
export const SECRET_ENV_KEYS = ["DATABASE_URL"] as const;

export const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid connection URL" }),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;
