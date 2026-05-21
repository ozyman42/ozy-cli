import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// --- types ---

export interface GitConfigSubmodule {
  name: string;
  url?: string;
  path?: string;
  active?: boolean;
}

export interface ModuleDirInfo {
  /** Path relative to .git/modules/ */
  relativePath: string;
  /** URL from this module dir's own git config [remote "origin"] */
  remoteUrl?: string;
}

export interface WorkingTreeGitEntry {
  /** Submodule path relative to repo root */
  path: string;
  /** Whether .git at this path is a gitdir-redirect file, a full directory, or absent */
  type: "file" | "dir" | "missing";
  /** Content of the gitdir: line when type === "file" */
  gitdirTarget?: string;
}

export interface IndexGitlink {
  path: string;
  commit: string;
}

export interface GitState {
  /** Submodule stanzas found in .git/config */
  config: GitConfigSubmodule[];
  /** Git dirs found under .git/modules/, each with their remote URL */
  moduleDirs: ModuleDirInfo[];
  /** Gitlink entries recorded in the index (mode 160000) */
  index: IndexGitlink[];
  /** State of .git file/dir in each known submodule working tree path */
  workingTree: WorkingTreeGitEntry[];
}

// --- parsers ---

function parseGitConfig(content: string): GitConfigSubmodule[] {
  const entries: GitConfigSubmodule[] = [];
  let current: Partial<GitConfigSubmodule> | null = null;

  for (const line of content.split("\n")) {
    const headerMatch = line.match(/^\[submodule "(.+)"\]$/);
    if (headerMatch) {
      if (current?.name) entries.push(current as GitConfigSubmodule);
      current = { name: headerMatch[1] };
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(/^\s+(\w+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const [, key, value] = kvMatch;
    if (key === "url") current.url = value.trim();
    else if (key === "path") current.path = value.trim();
    else if (key === "active") current.active = value.trim() === "true";
  }
  if (current?.name) entries.push(current as GitConfigSubmodule);
  return entries;
}

function parseIndexGitlinks(output: string): IndexGitlink[] {
  return output
    .split("\n")
    .filter((l) => l.startsWith("160000 "))
    .map((line) => {
      const match = line.match(/^160000 ([0-9a-f]{40}) \d\t(.+)$/);
      if (!match) throw new Error(`Unexpected ls-files line: ${line}`);
      return { commit: match[1], path: match[2] };
    });
}

/** Recursively finds directories under root that contain a HEAD file (real git dirs). */
function findGitDirs(root: string, rel = ""): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const relPath = rel ? `${rel}/${entry}` : entry;
    if (!statSync(abs).isDirectory()) continue;
    if (existsSync(join(abs, "HEAD"))) {
      results.push(relPath);
    } else {
      results.push(...findGitDirs(abs, relPath));
    }
  }
  return results;
}

async function readModuleDirRemoteUrl(abs: string): Promise<string | undefined> {
  const configPath = join(abs, "config");
  if (!existsSync(configPath)) return undefined;
  const content = await readFile(configPath, "utf8");
  const match = content.match(/\[remote "origin"\][^\[]*\n\s+url\s*=\s*(.+)/);
  return match?.[1].trim();
}

async function readWorkingTreeEntry(repoRoot: string, subPath: string): Promise<WorkingTreeGitEntry> {
  const dotGit = join(repoRoot, subPath, ".git");
  if (!existsSync(dotGit)) return { path: subPath, type: "missing" };
  if (statSync(dotGit).isDirectory()) return { path: subPath, type: "dir" };
  const content = await readFile(dotGit, "utf8");
  const match = content.match(/^gitdir:\s*(.+)$/m);
  return { path: subPath, type: "file", gitdirTarget: match?.[1].trim() };
}

// --- main reader ---

export async function readGitState(repoRoot: string, extraPaths: string[] = []): Promise<GitState> {
  const gitDir = resolve(repoRoot, ".git");

  const [configContent, lsOutput] = await Promise.all([
    readFile(resolve(gitDir, "config"), "utf8"),
    new Response(
      Bun.spawn(["git", "ls-files", "--stage"], { cwd: repoRoot, stdout: "pipe" }).stdout
    ).text(),
  ]);

  const config = parseGitConfig(configContent);
  const index = parseIndexGitlinks(lsOutput);

  const modulesRoot = resolve(gitDir, "modules");
  const moduleDirPaths = findGitDirs(modulesRoot);
  const moduleDirs = await Promise.all(
    moduleDirPaths.map(async (rel) => ({
      relativePath: rel,
      remoteUrl: await readModuleDirRemoteUrl(join(modulesRoot, rel)),
    }))
  );

  const allPaths = [
    ...new Set([
      ...index.map((e) => e.path),
      ...config.flatMap((e) => (e.path ? [e.path] : [])),
      ...extraPaths,
    ]),
  ];
  const workingTree = await Promise.all(
    allPaths.map((p) => readWorkingTreeEntry(repoRoot, p))
  );

  return { config, moduleDirs, index, workingTree };
}
