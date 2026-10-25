import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import type { EffectGen } from "effective-modules";

/**
 * A submodule's .git is a redirect file ("gitdir: <relative path>"), not a directory —
 * resolve it to the real git dir so callers don't try to treat the file as a directory.
 */
export function* resolveGitDir(repoRoot: string): EffectGen<string, string> {
  const dotGit = resolve(repoRoot, ".git");
  const isDirectory = yield* Effect.try({
    try: () => statSync(dotGit).isDirectory(),
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
  if (isDirectory) return dotGit;
  const content = yield* Effect.tryPromise({
    try: () => readFile(dotGit, "utf8"),
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return yield* Effect.fail(`Malformed .git file at ${dotGit}`);
  return resolve(repoRoot, match[1]!.trim());
}
