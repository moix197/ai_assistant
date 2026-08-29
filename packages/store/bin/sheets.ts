#!/usr/bin/env node
import { createPool } from "../src/pool";
import type { SheetRegistryEntry } from "../src/sheet-registry-repo";
import { getBySlug, listAll, remove, upsert } from "../src/sheet-registry-repo";
import { CliUsageError, type ParsedCommand, parseArgs } from "../src/sheets-cli";

function formatEntry(entry: SheetRegistryEntry): string {
  return `${entry.slug}\t${entry.spreadsheetId}\t${entry.access}\t${entry.valueInputOption}\t${entry.description}`;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Missing required environment variable "DATABASE_URL"');
    process.exit(1);
  }

  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  const pool = createPool(databaseUrl);
  try {
    if (parsed.command === "add") {
      await upsert(pool, {
        slug: parsed.slug,
        spreadsheetId: parsed.spreadsheetId,
        description: parsed.description,
        access: parsed.access,
        valueInputOption: parsed.valueInputOption,
      });
      const saved = await getBySlug(pool, parsed.slug);
      console.log(`Registered "${parsed.slug}"`);
      if (saved) console.log(formatEntry(saved));
    } else if (parsed.command === "list") {
      const entries = await listAll(pool);
      if (entries.length === 0) {
        console.log("No sheets registered.");
      } else {
        for (const entry of entries) console.log(formatEntry(entry));
      }
    } else {
      await remove(pool, parsed.slug);
      console.log(`Removed "${parsed.slug}" (if it was registered).`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
