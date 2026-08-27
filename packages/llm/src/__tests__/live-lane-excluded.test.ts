/**
 * Proves — rather than asserts in prose — that the paid live lane is not part
 * of `pnpm test`, and therefore not part of CI.
 *
 * The exclusion is one `--exclude` flag in this package's `test` script. A
 * human reading that line is the only thing that has ever checked it, which is
 * exactly the gap `01-llm-port` Phase 6 flagged as unverifiable by inspection.
 * So this test reads the glob back out of `package.json` at run time instead of
 * restating it: a duplicated copy of the pattern would keep passing after
 * someone narrowed, mistyped, or deleted the real flag.
 *
 * See `.ai/decisions/ci-lane-policy.md` for why the live lane is excluded.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `packages/llm/`, two directories up from `src/__tests__/`. */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const LIVE_SUFFIX = ".live.test.ts";

/**
 * Every `*.test.ts` under `src`, as POSIX paths relative to the package root —
 * the same shape vitest matches its `--exclude` glob against.
 */
function listTestFilesUnderSrc(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith(".test.ts"))
        found.push(relative(PACKAGE_ROOT, absolute).split(sep).join("/"));
    }
  };
  walk(join(PACKAGE_ROOT, "src"));
  return found.sort();
}

/** The glob this package's `test` script actually hands vitest, never a copy of it. */
function readExcludeGlobFromPackageJson(): string {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string | undefined>;
  };
  const testScript = manifest.scripts?.test;
  if (!testScript) throw new Error('packages/llm/package.json has no "test" script');
  const match = /--exclude(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(testScript);
  if (!match)
    throw new Error(
      `packages/llm's "test" script passes no --exclude, so the live lane is not excluded: ${testScript}`,
    );
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/**
 * Hand-rolled because one pattern (`**\/*.live.test.ts`) does not justify a glob
 * dependency — build-our-own-first, per CLAUDE.md. `**\/` spans directories,
 * `*` and `?` stop at a separator.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? "";
    if (char === "*") {
      if (glob[i + 1] === "*" && glob[i + 2] === "/") {
        pattern += "(?:[^/]+/)*";
        i += 2;
      } else if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

describe("the live test lane is excluded from `pnpm test`", () => {
  it("has live test files to exclude in the first place", () => {
    const liveFiles = listTestFilesUnderSrc().filter((file) => file.endsWith(LIVE_SUFFIX));

    // Without this, every assertion below would pass vacuously the day the
    // live suite is renamed or moved out of `src`.
    expect(liveFiles.length).toBeGreaterThan(0);
  });

  it("excludes every live test file via the glob package.json actually passes", () => {
    const excludeGlob = globToRegExp(readExcludeGlobFromPackageJson());
    const liveFiles = listTestFilesUnderSrc().filter((file) => file.endsWith(LIVE_SUFFIX));

    const notExcluded = liveFiles.filter((file) => !excludeGlob.test(file));
    expect(notExcluded).toEqual([]);
  });

  it("leaves no live test file in the set the unit lane would run", () => {
    const excludeGlob = globToRegExp(readExcludeGlobFromPackageJson());

    const wouldRun = listTestFilesUnderSrc().filter((file) => !excludeGlob.test(file));
    expect(wouldRun.filter((file) => file.endsWith(LIVE_SUFFIX))).toEqual([]);
  });
});
