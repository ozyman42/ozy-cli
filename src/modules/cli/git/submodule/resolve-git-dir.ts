import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// A submodule's .git is a redirect file ("gitdir: <relative path>"), not a directory —
// resolve it to the real git dir so callers don't try to treat the file as a directory.
export async function resolveGitDir(repoRoot: string): Promise<string> {
  const dotGit = resolve(repoRoot, ".git");
  if (statSync(dotGit).isDirectory()) return dotGit;
  const content = await readFile(dotGit, "utf8");
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) throw new Error(`Malformed .git file at ${dotGit}`);
  return resolve(repoRoot, match[1]!.trim());
}
