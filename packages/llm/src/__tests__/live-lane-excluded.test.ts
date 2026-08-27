/**
 * Proves — rather than asserts in prose — that the paid live lane is not part
 * of `pnpm test`, and therefore not part of CI.
 *
 * The exclusion is one `--exclude` flag in a package's `test` script. A human
 * reading that line is the only thing that has ever checked it, which is
 * exactly the gap `01-llm-port` Phase 6 flagged as unverifiable by inspection.
 * So this test reads the glob back out of `package.json` at run time instead of
 * restating it: a duplicated copy of the pattern would keep passing after
 * someone narrowed, mistyped, or deleted the real flag.
 *
 * Two things are checked for every package, not just this one: files matching
 * the `.live.test.ts` suffix, and every `*.test.ts` under the directory the
 * package's `test:live` script actually points `--dir` at. The paid lane is a
 * directory, so a live suite named `live/foo.test.ts` would otherwise run in
 * both lanes with only prose forbidding it. The walk starts at the workspace
 * root so a live suite added in another package is caught the same way.
 *
 * See `.ai/decisions/ci-lane-policy.md` for why the live lane is excluded.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `packages/llm/`, two directories up from `src/__tests__/`. */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const LIVE_SUFFIX = ".live.test.ts";

/** Directories that hold no source of ours; walking them is slow and pointless. */
const UNWALKED = new Set(["node_modules", "dist", ".git"]);

/** The directory holding `pnpm-workspace.yaml`, found by walking up. */
function findWorkspaceRoot(): string {
  let dir = PACKAGE_ROOT;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no pnpm-workspace.yaml above packages/llm");
    dir = parent;
  }
  return dir;
}

const WORKSPACE_ROOT = findWorkspaceRoot();

function walk(dir: string, visit: (absolute: string, isDirectory: boolean) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (UNWALKED.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    visit(absolute, entry.isDirectory());
    if (entry.isDirectory()) walk(absolute, visit);
  }
}

/** Every `*.test.ts` under `dir`, as absolute paths. */
function listTestFiles(dir: string): string[] {
  const found: string[] = [];
  walk(dir, (absolute, isDirectory) => {
    if (!isDirectory && absolute.endsWith(".test.ts")) found.push(absolute);
  });
  return found.sort();
}

/** Every workspace package directory — anything with its own `package.json`. */
function listPackageRoots(): string[] {
  const found: string[] = [];
  walk(WORKSPACE_ROOT, (absolute, isDirectory) => {
    if (isDirectory && existsSync(join(absolute, "package.json"))) found.push(absolute);
  });
  return found.sort();
}

/** POSIX path relative to `from` — the shape vitest matches its globs against. */
function toRelativePosix(from: string, absolute: string): string {
  return relative(from, absolute).split(sep).join("/");
}

function readScript(packageRoot: string, name: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string | undefined>;
  };
  return manifest.scripts?.[name];
}

/** The value a `--flag`/`--flag=` argument carries in a script string, if present. */
function readFlagValue(script: string, flag: string): string | undefined {
  const match = new RegExp(`--${flag}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`).exec(script);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

/** The glob a package's `test` script actually hands vitest, never a copy of it. */
function readExcludeGlob(packageRoot: string): string {
  const testScript = readScript(packageRoot, "test");
  const name = toRelativePosix(WORKSPACE_ROOT, packageRoot);
  if (!testScript) throw new Error(`${name}/package.json has no "test" script`);
  const exclude = readFlagValue(testScript, "exclude");
  if (exclude === undefined)
    throw new Error(
      `${name}'s "test" script passes no --exclude, so the live lane is not excluded: ${testScript}`,
    );
  return exclude;
}

/** The directory a package's `test:live` script points `--dir` at, if it has one. */
function readLiveDir(packageRoot: string): string | undefined {
  const liveScript = readScript(packageRoot, "test:live");
  const dir = liveScript === undefined ? undefined : readFlagValue(liveScript, "dir");
  return dir === undefined ? undefined : resolve(packageRoot, dir);
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

/** Of `files`, the ones their own package's `test` lane would still collect. */
function notExcludedBy(packageRoot: string, files: string[]): string[] {
  const excludeGlob = globToRegExp(readExcludeGlob(packageRoot));
  return files
    .filter((file) => !excludeGlob.test(toRelativePosix(packageRoot, file)))
    .map((file) => toRelativePosix(WORKSPACE_ROOT, file));
}

/** Package roots paired with the live test files each one owns, workspace-wide. */
function packagesWithLiveFiles(): [string, string[]][] {
  return listPackageRoots()
    .map((packageRoot): [string, string[]] => [
      packageRoot,
      listTestFiles(packageRoot).filter((file) => file.endsWith(LIVE_SUFFIX)),
    ])
    .filter(([, liveFiles]) => liveFiles.length > 0);
}

describe("the live test lane is excluded from `pnpm test`", () => {
  it("has live test files to exclude in the first place", () => {
    // Without this, every assertion below would pass vacuously the day the
    // live suite is renamed or moved out of the packages it walks.
    expect(packagesWithLiveFiles().length).toBeGreaterThan(0);
  });

  it("excludes every live test file via the glob its own package.json passes", () => {
    for (const [packageRoot, liveFiles] of packagesWithLiveFiles())
      expect(notExcludedBy(packageRoot, liveFiles)).toEqual([]);
  });

  it("leaves no live test file in the set a unit lane would run", () => {
    for (const [packageRoot] of packagesWithLiveFiles()) {
      const wouldRun = notExcludedBy(packageRoot, listTestFiles(packageRoot));
      expect(wouldRun.filter((file) => file.endsWith(LIVE_SUFFIX))).toEqual([]);
    }
  });

  it("excludes every test file under the directory the paid lane runs", () => {
    const liveDirs = listPackageRoots()
      .map((packageRoot): [string, string | undefined] => [packageRoot, readLiveDir(packageRoot)])
      .filter((entry): entry is [string, string] => entry[1] !== undefined);

    // The paid lane is `--dir`, not a filename suffix: `live/foo.test.ts` is
    // billed too, and the suffix checks above would never see it.
    expect(liveDirs.length).toBeGreaterThan(0);
    for (const [packageRoot, liveDir] of liveDirs)
      expect(notExcludedBy(packageRoot, listTestFiles(liveDir))).toEqual([]);
  });
});
