import { existsSync, statSync } from "node:fs";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { Effect } from "effect";
import type { EffectGen } from "effective-modules";
import type { IOSPlatform } from "@/modules/common/os-platform/interface";
import type { Gitmodules } from "./gitmodules";
import type { ModuleDirInfo, IndexGitlink } from "./git-state";
import { resolveGitDir } from "./resolve-git-dir";

export interface Fix {
  location: string[];
  action: "synced" | "deleted";
  detail?: string;
}

function parseConfigSubmoduleValues(content: string): Map<string, { url?: string; path?: string }> {
  const entries = new Map<string, { url?: string; path?: string }>();
  let current: { url?: string; path?: string } | null = null;

  for (const line of content.split("\n")) {
    const headerMatch = line.match(/^\[submodule "(.+)"\]$/);
    if (headerMatch) {
      current = {};
      entries.set(headerMatch[1]!, current);
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(/^\s+(\w+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const [, key, value] = kvMatch;
    if (key === "url" || key === "path") current[key] = value!.trim();
  }

  return entries;
}

// Drops any stanza whose name isn't a valid submodule, is a stale duplicate, or
// has url/path values that no longer match .gitmodules — so it can be re-added fresh.
function removeExtraConfigSubmodules(content: string, modules: Gitmodules): { result: string; removed: string[] } {
  const byName = new Map(modules.list.map((m) => [m.name, m]));
  const existingValues = parseConfigSubmoduleValues(content);

  const staleNames = new Set<string>();
  for (const [name, values] of existingValues) {
    const m = byName.get(name);
    if (!m || values.url !== m.url || values.path !== m.path) staleNames.add(name);
  }

  const removed: string[] = [];
  const seen = new Set<string>();
  const output: string[] = [];
  let dropping = false;

  for (const line of content.split("\n")) {
    const submoduleMatch = line.match(/^\[submodule "(.+)"\]$/);
    if (submoduleMatch) {
      const name = submoduleMatch[1]!;
      if (!staleNames.has(name) && !seen.has(name)) {
        seen.add(name);
        dropping = false;
      } else {
        removed.push(name);
        dropping = true;
      }
    } else if (/^\[/.test(line)) {
      dropping = false;
    }
    if (!dropping) output.push(line);
  }

  return { result: output.join("\n"), removed };
}

function* readTextFile(path: string): EffectGen<string, string> {
  return yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

function* writeTextFile(path: string, content: string): EffectGen<void, string> {
  return yield* Effect.tryPromise({
    try: () => writeFile(path, content, "utf8"),
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

function* makeDirectory(path: string): EffectGen<void, string> {
  yield* Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

function* renamePath(from: string, to: string): EffectGen<void, string> {
  return yield* Effect.tryPromise({
    try: () => rename(from, to),
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

function* removePath(path: string): EffectGen<void, string> {
  return yield* Effect.tryPromise({
    try: () => rm(path, { recursive: true, force: true }),
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

function* spawnGit(osPlatform: IOSPlatform, args: string[], cwd: string): EffectGen<void, string> {
  const result = yield* osPlatform.spawnProcess({ command: "git", args, cwd });
  if (result.exitCode !== 0) {
    return yield* Effect.fail(`git ${args.join(" ")} exited with code ${result.exitCode}\n${result.stderr.trim()}`);
  }
}

export function* fixGitConfig(repoRoot: string, modules: Gitmodules): EffectGen<Fix[], string> {
  const gitDir = yield* resolveGitDir(repoRoot);
  const configPath = resolve(gitDir, "config");
  const content = yield* readTextFile(configPath);
  const { result: afterRemoval, removed } = removeExtraConfigSubmodules(content, modules);

  const existingNames = new Set<string>(
    [...afterRemoval.matchAll(/^\[submodule "(.+)"\]$/gm)].map((m) => m[1]!)
  );
  const missing = modules.list.filter((m) => !existingNames.has(m.name));

  let result = afterRemoval;
  for (const m of missing) {
    if (!result.endsWith("\n")) result += "\n";
    result += `[submodule "${m.name}"]\n\tactive = true\n\turl = ${m.url}\n\tpath = ${m.path}\n`;
  }

  if (removed.length === 0 && missing.length === 0) return [];
  yield* writeTextFile(configPath, result);
  return [
    ...removed.map((name) => ({ location: [".git", "config", name], action: "deleted" as const })),
    ...missing.map((m) => ({ location: [".git", "config", m.name], action: "synced" as const })),
  ];
}

const GIT_MODULES_MARKER = ".git/modules/";

// A stale redirect's leading "../" prefix can be wrong after a path rename, but the
// suffix starting at ".git/modules/" always describes a location under the single
// top-level .git, at any nesting depth — so anchor on that marker instead of trusting
// the relative resolution.
function recoverStaleGitDirTarget(redirectContent: string, topLevelRoot: string): string | undefined {
  const match = redirectContent.match(/^gitdir:\s*(.+)$/m);
  if (!match) return undefined;
  const idx = match[1]!.indexOf(GIT_MODULES_MARKER);
  if (idx === -1) return undefined;
  return resolve(topLevelRoot, match[1]!.slice(idx).trim());
}

/**
 * Moves existing git data into moduleGitDir instead of abandoning it, whether it's a
 * standalone clone's literal .git directory, or a redirect file (even a stale one
 * left over from a path rename) pointing at git data that still exists.
 */
function* migrateExistingGitDir(workingTreeDir: string, moduleGitDir: string, topLevelRoot: string): EffectGen<boolean, string> {
  const dotGit = join(workingTreeDir, ".git");
  if (!existsSync(dotGit)) return false;

  if (statSync(dotGit).isDirectory()) {
    yield* makeDirectory(dirname(moduleGitDir));
    yield* renamePath(dotGit, moduleGitDir);
    return true;
  }

  const content = yield* readTextFile(dotGit);
  const target = recoverStaleGitDirTarget(content, topLevelRoot);
  if (!target || target === moduleGitDir || !existsSync(target)) return false;
  yield* makeDirectory(dirname(moduleGitDir));
  yield* renamePath(target, moduleGitDir);
  return true;
}

export function* fixModuleDirs(
  osPlatform: IOSPlatform,
  repoRoot: string,
  modules: Gitmodules,
  moduleDirs: ModuleDirInfo[],
  orphanModuleDirs: string[],
  topLevelRoot: string,
): EffectGen<Fix[], string> {
  const fixes: Fix[] = [];
  const modulesRoot = resolve(yield* resolveGitDir(repoRoot), "modules");

      // Establish each module's git dir (migrating existing data if any exists
      // anywhere) before the orphan cleanup below runs, so nothing real gets deleted
      // out from under a path rename.
      for (const m of modules.list) {
        const workingTreeDir = resolve(repoRoot, m.path);
        const moduleGitDir = join(modulesRoot, m.path);
        if (!existsSync(workingTreeDir)) continue;

        const alreadyEstablished = existsSync(moduleGitDir);
        let freshlyCloned = false;

        if (!alreadyEstablished) {
          const migrated = yield* migrateExistingGitDir(workingTreeDir, moduleGitDir, topLevelRoot);
          if (migrated) {
            fixes.push({ location: [".git", "modules", ...m.path.split("/")], action: "synced", detail: "migrated" });
          } else {
            yield* makeDirectory(dirname(moduleGitDir));
            yield* spawnGit(osPlatform, ["clone", "--bare", m.url, moduleGitDir], repoRoot);
            fixes.push({ location: [".git", "modules", ...m.path.split("/")], action: "synced", detail: "initialized" });
            freshlyCloned = true;
          }
        }

        if (freshlyCloned) {
          const configFile = join(moduleGitDir, "config");
          const worktree = relative(moduleGitDir, workingTreeDir);
          yield* spawnGit(osPlatform, ["config", "-f", configFile, "core.bare", "false"], repoRoot);
          yield* spawnGit(osPlatform, ["config", "-f", configFile, "core.worktree", worktree], repoRoot);
        }

        // A bare clone (whether just made above, or left over from a prior buggy
        // run) never gets an index — populate it from HEAD whenever it's missing,
        // not only right after we ourselves created it.
        if (!existsSync(join(moduleGitDir, "index"))) {
          const headCheck = yield* osPlatform.spawnProcess({
            command: "git",
            args: ["--git-dir", moduleGitDir, "rev-parse", "--verify", "HEAD"],
            stdout: "ignore",
            stderr: "ignore",
          });
          if (headCheck.exitCode !== 0) yield* spawnGit(osPlatform, ["--git-dir", moduleGitDir, "fetch", "origin"], repoRoot);
          yield* spawnGit(osPlatform, ["--git-dir", moduleGitDir, "read-tree", "HEAD"], repoRoot);
          fixes.push({ location: [".git", "modules", ...m.path.split("/")], action: "synced", detail: "populated index" });
        }

        // Always re-point the working tree's .git redirect — never assume an
        // existing file is already correct.
        const dotGit = join(workingTreeDir, ".git");
        const rel = relative(workingTreeDir, moduleGitDir);
        const desired = `gitdir: ${rel}\n`;
        const current = existsSync(dotGit) && !statSync(dotGit).isDirectory()
          ? yield* readTextFile(dotGit)
          : undefined;
        if (current !== desired) {
          yield* writeTextFile(dotGit, desired);
          fixes.push({ location: [...m.path.split("/"), ".git"], action: "synced" });
        }
      }

      const gmByPath = new Map(modules.list.map((m) => [m.path, m]));

      for (const d of moduleDirs) {
        const gm = gmByPath.get(d.relativePath);
        if (!gm && existsSync(join(modulesRoot, d.relativePath))) {
          yield* removePath(join(modulesRoot, d.relativePath));
          fixes.push({ location: [".git", "modules", ...d.relativePath.split("/")], action: "deleted" });
        }
      }

      for (const rel of orphanModuleDirs) {
        if (existsSync(join(modulesRoot, rel))) {
          yield* removePath(join(modulesRoot, rel));
          fixes.push({ location: [".git", "modules", ...rel.split("/")], action: "deleted" });
        }
      }

      for (const m of modules.list) {
        const moduleGitDir = join(modulesRoot, m.path);
        if (!existsSync(moduleGitDir)) continue;
        const configFile = join(moduleGitDir, "config");

        const currentUrlResult = yield* osPlatform.spawnProcess({
          command: "git",
          args: ["config", "-f", configFile, "remote.origin.url"],
          cwd: repoRoot,
        });
        const currentWorktreeResult = yield* osPlatform.spawnProcess({
          command: "git",
          args: ["config", "-f", configFile, "core.worktree"],
          cwd: repoRoot,
        });
        const currentUrl = currentUrlResult.exitCode === 0 ? currentUrlResult.stdout.trim() : "";
        const currentWorktree = currentWorktreeResult.exitCode === 0 ? currentWorktreeResult.stdout.trim() : "";

        const worktree = relative(moduleGitDir, resolve(repoRoot, m.path));

        if (currentUrl !== m.url) {
          yield* spawnGit(osPlatform, ["config", "-f", configFile, "remote.origin.url", m.url], repoRoot);
          fixes.push({ location: [".git", "modules", ...m.path.split("/"), "config"], action: "synced", detail: "remote.origin.url" });
        }
        if (currentWorktree !== worktree) {
          yield* spawnGit(osPlatform, ["config", "-f", configFile, "core.worktree", worktree], repoRoot);
          fixes.push({ location: [".git", "modules", ...m.path.split("/"), "config"], action: "synced", detail: "core.worktree" });
        }
      }

      return fixes;
}

export function* fixIndexGitlinks(
  osPlatform: IOSPlatform,
  repoRoot: string,
  modules: Gitmodules,
  currentIndex: IndexGitlink[],
): EffectGen<Fix[], string> {
  const currentShas = new Map(currentIndex.map((e) => [e.path, e.commit]));
  const validPaths = new Set(modules.list.map((m) => m.path));
  const fixes: Fix[] = [];

      for (const entry of currentIndex) {
        if (!validPaths.has(entry.path)) {
          yield* spawnGit(osPlatform, ["update-index", "--force-remove", entry.path], repoRoot);
          fixes.push({ location: [".git", "index"], action: "deleted", detail: entry.path });
        }
      }

      for (const m of modules.list) {
        const workingTree = resolve(repoRoot, m.path);
        if (!existsSync(workingTree)) continue;

        const shaResult = yield* osPlatform.spawnProcess({
          command: "git",
          args: ["rev-parse", "HEAD"],
          cwd: workingTree,
        });
        const sha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : "";
        if (!/^[0-9a-f]{40}$/.test(sha)) continue;

        const current = currentShas.get(m.path);
        yield* spawnGit(osPlatform, ["update-index", "--add", "--cacheinfo", `160000,${sha},${m.path}`], repoRoot);
        if (current !== sha) {
          fixes.push({ location: [".git", "index"], action: "synced", detail: `${m.path}: ${sha.slice(0, 8)}` });
        }
      }

      return fixes;
}
