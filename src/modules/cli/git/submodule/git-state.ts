import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect, Option } from "effect";
import { resolveGitDir } from "./resolve-git-dir";

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
  /** Result of `git remote get-url origin` run inside the working tree dir */
  remote?: string | { error: string };
  /** Result of `git rev-parse HEAD` run inside the working tree dir */
  headCommit?: string | { error: string };
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
  /** Dirs under .git/modules/ that contain no HEAD file and aren't prefixes of any known module path */
  orphanModuleDirs: string[];
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
    if (key === "url") current.url = value!.trim();
    else if (key === "path") current.path = value!.trim();
    else if (key === "active") current.active = value!.trim() === "true";
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
      return { commit: match[1]!, path: match[2]! };
    });
}

/**
 * Recursively scans .git/modules/, returning:
 * - gitDirs: paths of real git dirs (contain a HEAD file)
 * - orphanDirs: paths that are neither a git dir nor a prefix of any known module path
 */
function scanModuleDirs(
  root: string,
  modulePaths: Set<string>,
  rel = "",
): { gitDirs: string[]; orphanDirs: string[] } {
  const gitDirs: string[] = [];
  const orphanDirs: string[] = [];
  if (!existsSync(root)) return { gitDirs, orphanDirs };

  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    if (!statSync(abs).isDirectory()) continue;
    const relPath = rel ? `${rel}/${entry}` : entry;

    if (existsSync(join(abs, "HEAD"))) {
      gitDirs.push(relPath);
    } else {
      const isPrefix = [...modulePaths].some((p) => p.startsWith(relPath + "/"));
      if (isPrefix) {
        const sub = scanModuleDirs(abs, modulePaths, relPath);
        gitDirs.push(...sub.gitDirs);
        orphanDirs.push(...sub.orphanDirs);
      } else {
        orphanDirs.push(relPath);
      }
    }
  }

  return { gitDirs, orphanDirs };
}

async function readModuleDirRemoteUrl(abs: string): Promise<Option.Option<string>> {
  const configPath = join(abs, "config");
  if (!existsSync(configPath)) return Option.none();
  const content = await readFile(configPath, "utf8");
  const match = content.match(/\[remote "origin"\][^\[]*\n\s+url\s*=\s*(.+)/);
  return match?.[1] ? Option.some(match[1].trim()) : Option.none();
}

async function spawnGitInDir(args: string[], cwd: string): Promise<string | { error: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return code === 0 ? out.trim() : { error: err.trim().split("\n")[0]! };
}

async function readWorkingTreeEntry(repoRoot: string, subPath: string): Promise<WorkingTreeGitEntry> {
  const workingTreeAbs = join(repoRoot, subPath);
  const dotGit = join(workingTreeAbs, ".git");

  let type: "file" | "dir" | "missing";
  let gitdirTarget: string | undefined;

  if (!existsSync(dotGit)) {
    type = "missing";
  } else if (statSync(dotGit).isDirectory()) {
    type = "dir";
  } else {
    type = "file";
    const content = await readFile(dotGit, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    gitdirTarget = match?.[1].trim();
  }

  if (!existsSync(workingTreeAbs)) return { path: subPath, type, gitdirTarget };

  const [remote, headCommit] = await Promise.all([
    spawnGitInDir(["remote", "get-url", "origin"], workingTreeAbs),
    spawnGitInDir(["rev-parse", "HEAD"], workingTreeAbs),
  ]);

  return { path: subPath, type, gitdirTarget, remote, headCommit };
}

// --- main reader ---

export function readGitState(repoRoot: string, extraPaths: string[] = []): Effect.Effect<GitState, string> {
  return Effect.tryPromise({
    try: async () => {
      const gitDir = await resolveGitDir(repoRoot);

      const [configContent, lsOutput] = await Promise.all([
        readFile(resolve(gitDir, "config"), "utf8"),
        new Response(
          Bun.spawn(["git", "ls-files", "--stage"], { cwd: repoRoot, stdout: "pipe" }).stdout
        ).text(),
      ]);

      const config = parseGitConfig(configContent);
      const index = parseIndexGitlinks(lsOutput);

      const modulePaths = new Set(extraPaths);
      const modulesRoot = resolve(gitDir, "modules");
      const { gitDirs: moduleDirPaths, orphanDirs: orphanModuleDirs } = scanModuleDirs(modulesRoot, modulePaths);
      const moduleDirs = await Promise.all(
        moduleDirPaths.map(async (rel) => {
          const remoteUrlOption = await readModuleDirRemoteUrl(join(modulesRoot, rel));
          return {
            relativePath: rel,
            remoteUrl: Option.isSome(remoteUrlOption) ? remoteUrlOption.value : undefined,
          };
        })
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

      return { config, moduleDirs, orphanModuleDirs, index, workingTree };
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}
