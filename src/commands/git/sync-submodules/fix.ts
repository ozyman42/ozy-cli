import { existsSync, statSync } from "node:fs";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { Effect } from "effect";
import type { Gitmodules } from "./gitmodules";
import type { ModuleDirInfo, IndexGitlink } from "./git-state";

export interface Fix {
  location: string[];
  action: "synced" | "deleted";
  detail?: string;
}

function removeExtraConfigSubmodules(content: string, validNames: Set<string>): { result: string; removed: string[] } {
  const removed: string[] = [];
  const seen = new Set<string>();
  const output: string[] = [];
  let dropping = false;

  for (const line of content.split("\n")) {
    const submoduleMatch = line.match(/^\[submodule "(.+)"\]$/);
    if (submoduleMatch) {
      const name = submoduleMatch[1]!;
      if (validNames.has(name) && !seen.has(name)) {
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

async function spawnGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} exited with code ${code}\n${err.trim()}`);
  }
}

export function fixGitConfig(repoRoot: string, modules: Gitmodules): Effect.Effect<Fix[], string> {
  return Effect.tryPromise({
    try: async () => {
      const configPath = resolve(repoRoot, ".git", "config");
      const content = await readFile(configPath, "utf8");
      const validNames = new Set(modules.map((m) => m.name));
      const { result: afterRemoval, removed } = removeExtraConfigSubmodules(content, validNames);

      const existingNames = new Set<string>(
        [...afterRemoval.matchAll(/^\[submodule "(.+)"\]$/gm)].map((m) => m[1]!)
      );
      const missing = modules.filter((m) => !existingNames.has(m.name));

      let result = afterRemoval;
      for (const m of missing) {
        if (!result.endsWith("\n")) result += "\n";
        result += `[submodule "${m.name}"]\n\tactive = true\n\turl = ${m.url}\n\tpath = ${m.path}\n`;
      }

      if (removed.length === 0 && missing.length === 0) return [];
      await writeFile(configPath, result, "utf8");
      return [
        ...removed.map((name) => ({ location: [".git", "config", name], action: "deleted" as const })),
        ...missing.map((m) => ({ location: [".git", "config", m.name], action: "synced" as const })),
      ];
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

export function fixModuleDirs(
  repoRoot: string,
  modules: Gitmodules,
  moduleDirs: ModuleDirInfo[],
  orphanModuleDirs: string[],
): Effect.Effect<Fix[], string> {
  return Effect.tryPromise({
    try: async () => {
      const fixes: Fix[] = [];
      const modulesRoot = resolve(repoRoot, ".git", "modules");
      const gmByPath = new Map(modules.map((m) => [m.path, m]));

      for (const d of moduleDirs) {
        const gm = gmByPath.get(d.relativePath);
        if (!gm) {
          await rm(join(modulesRoot, d.relativePath), { recursive: true, force: true });
          fixes.push({ location: [".git", "modules", ...d.relativePath.split("/")], action: "deleted" });
        }
      }

      for (const rel of orphanModuleDirs) {
        await rm(join(modulesRoot, rel), { recursive: true, force: true });
        fixes.push({ location: [".git", "modules", ...rel.split("/")], action: "deleted" });
      }

      for (const m of modules) {
        const workingTreeDir = resolve(repoRoot, m.path);
        const moduleGitDir = join(modulesRoot, m.path);
        const dotGit = join(workingTreeDir, ".git");
        if (!existsSync(workingTreeDir)) continue;

        if (existsSync(dotGit) && statSync(dotGit).isDirectory()) {
          if (existsSync(moduleGitDir)) continue;
          await mkdir(dirname(moduleGitDir), { recursive: true });
          await rename(dotGit, moduleGitDir);
          const rel = relative(workingTreeDir, moduleGitDir);
          await writeFile(dotGit, `gitdir: ${rel}\n`, "utf8");
          fixes.push({ location: [...m.path.split("/"), ".git"], action: "synced", detail: "migrated standalone .git" });
          continue;
        }

        if (!existsSync(moduleGitDir)) {
          await mkdir(dirname(moduleGitDir), { recursive: true });
          await spawnGit(["clone", "--bare", m.url, moduleGitDir], repoRoot);
          const configFile = `.git/modules/${m.path}/config`;
          const worktree = relative(moduleGitDir, workingTreeDir);
          await spawnGit(["config", "-f", configFile, "core.bare", "false"], repoRoot);
          await spawnGit(["config", "-f", configFile, "core.worktree", worktree], repoRoot);
          fixes.push({ location: [".git", "modules", ...m.path.split("/")], action: "synced", detail: "initialized" });
          continue;
        }

        if (existsSync(dotGit)) continue;
        const rel = relative(workingTreeDir, moduleGitDir);
        await writeFile(dotGit, `gitdir: ${rel}\n`, "utf8");
        fixes.push({ location: [...m.path.split("/"), ".git"], action: "synced" });
      }

      for (const m of modules) {
        const moduleGitDir = join(modulesRoot, m.path);
        if (!existsSync(moduleGitDir)) continue;
        const configFile = `.git/modules/${m.path}/config`;

        const readConfig = (key: string) =>
          Bun.spawn(["git", "config", "-f", configFile, key], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });

        const [currentUrl, currentWorktree] = await Promise.all([
          new Response(readConfig("remote.origin.url").stdout).text().then(t => t.trim()),
          new Response(readConfig("core.worktree").stdout).text().then(t => t.trim()),
        ]);

        const worktree = relative(moduleGitDir, resolve(repoRoot, m.path));

        if (currentUrl !== m.url) {
          await spawnGit(["config", "-f", configFile, "remote.origin.url", m.url], repoRoot);
          fixes.push({ location: [".git", "modules", ...m.path.split("/"), "config"], action: "synced", detail: "remote.origin.url" });
        }
        if (currentWorktree !== worktree) {
          await spawnGit(["config", "-f", configFile, "core.worktree", worktree], repoRoot);
          fixes.push({ location: [".git", "modules", ...m.path.split("/"), "config"], action: "synced", detail: "core.worktree" });
        }
      }

      return fixes;
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

export function fixIndexGitlinks(
  repoRoot: string,
  modules: Gitmodules,
  currentIndex: IndexGitlink[],
): Effect.Effect<Fix[], string> {
  return Effect.tryPromise({
    try: async () => {
      const currentShas = new Map(currentIndex.map((e) => [e.path, e.commit]));
      const fixes: Fix[] = [];

      for (const m of modules) {
        const workingTree = resolve(repoRoot, m.path);
        if (!existsSync(workingTree)) continue;

        const shaProc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: workingTree, stdout: "pipe", stderr: "pipe" });
        const sha = (await new Response(shaProc.stdout).text()).trim();
        if (!/^[0-9a-f]{40}$/.test(sha)) continue;

        const current = currentShas.get(m.path);
        await spawnGit(["update-index", "--add", "--cacheinfo", `160000,${sha},${m.path}`], repoRoot);
        if (current !== sha) {
          fixes.push({ location: [".git", "index"], action: "synced", detail: `${m.path}: ${sha.slice(0, 8)}` });
        }
      }

      return fixes;
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}
