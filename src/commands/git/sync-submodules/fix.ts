import { existsSync } from "node:fs";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import type { Gitmodules } from "./gitmodules";
import type { ModuleDirInfo } from "../../../../../sync-submodules/git-state";

/**
 * Removes [submodule "X"] stanzas from .git/config where X is not a known
 * submodule name, or is a duplicate. Returns names of removed stanzas.
 */
function removeExtraConfigSubmodules(content: string, validNames: Set<string>): { result: string; removed: string[] } {
  const removed: string[] = [];
  const seen = new Set<string>();
  const output: string[] = [];
  let dropping = false;

  for (const line of content.split("\n")) {
    const submoduleMatch = line.match(/^\[submodule "(.+)"\]$/);
    if (submoduleMatch) {
      const name = submoduleMatch[1];
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

/** Extracts the org/repo path portion of an SSH or HTTPS git URL. */
function repoPath(url: string): string {
  const stripped = url.replace(/\.git$/, "");
  if (stripped.startsWith("http")) {
    const parts = stripped.split("/");
    return parts.slice(-2).join("/");
  }
  const colonIdx = stripped.indexOf(":");
  return colonIdx >= 0 ? stripped.slice(colonIdx + 1) : stripped;
}

async function spawnGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited with code ${code}`);
}

export async function fixModuleDirs(repoRoot: string, modules: Gitmodules, moduleDirs: ModuleDirInfo[]): Promise<void> {
  const modulesRoot = resolve(repoRoot, ".git", "modules");
  const gmByRepoPath = new Map(modules.map((m) => [repoPath(m.url), m]));

  for (const d of moduleDirs) {
    const prefix = `  .git/modules/${d.relativePath}`;

    if (!d.remoteUrl) {
      console.log(`${prefix}: no remote URL, skipping`);
      continue;
    }

    const gm = gmByRepoPath.get(repoPath(d.remoteUrl));

    if (!gm) {
      await rm(join(modulesRoot, d.relativePath), { recursive: true, force: true });
      console.log(`${prefix}: deleted (orphaned, no matching submodule)`);
      continue;
    }

    if (d.relativePath === gm.path) {
      console.log(`${prefix}: already correct`);
      continue;
    }

    const targetAbs = join(modulesRoot, gm.path);
    if (existsSync(targetAbs)) {
      console.log(`${prefix}: target ${gm.path} already exists, skipping`);
      continue;
    }

    await mkdir(dirname(targetAbs), { recursive: true });
    await rename(join(modulesRoot, d.relativePath), targetAbs);
    console.log(`${prefix} → ${gm.path}`);
  }

  // Write .git redirect files so git recognises existing working trees
  for (const m of modules) {
    const workingTreeDir = resolve(repoRoot, m.path);
    const moduleGitDir = join(modulesRoot, m.path);
    const dotGit = join(workingTreeDir, ".git");
    if (!existsSync(workingTreeDir) || !existsSync(moduleGitDir) || existsSync(dotGit)) continue;
    const rel = relative(workingTreeDir, moduleGitDir);
    await writeFile(dotGit, `gitdir: ${rel}\n`, "utf8");
    console.log(`  wrote ${m.path}/.git → ${rel}`);
  }

  console.log("  running: git submodule sync");
  await spawnGit(["submodule", "sync"], repoRoot);

  // Set core.worktree in each module git dir so git knows where the working tree is
  for (const m of modules) {
    const moduleGitDir = join(modulesRoot, m.path);
    if (!existsSync(moduleGitDir)) continue;
    const worktree = relative(moduleGitDir, resolve(repoRoot, m.path));
    await spawnGit(["config", "-f", `.git/modules/${m.path}/config`, "core.worktree", worktree], repoRoot);
    console.log(`  set core.worktree for ${m.path}: ${worktree}`);
  }
}

export async function fixIndexGitlinks(repoRoot: string, modules: Gitmodules): Promise<void> {
  for (const m of modules) {
    const workingTree = resolve(repoRoot, m.path);
    if (!existsSync(workingTree)) {
      console.log(`  ${m.path}: working tree missing, skipping`);
      continue;
    }

    const shaProc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: workingTree, stdout: "pipe" });
    const sha = (await new Response(shaProc.stdout).text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      console.log(`  ${m.path}: could not read HEAD (${sha}), skipping`);
      continue;
    }

    await spawnGit(["update-index", "--cacheinfo", `160000,${sha},${m.path}`], repoRoot);
    console.log(`  ${m.path}: ${sha.slice(0, 8)}`);
  }
}

export async function fixGitConfig(repoRoot: string, modules: Gitmodules): Promise<void> {
  const configPath = resolve(repoRoot, ".git", "config");
  const content = await readFile(configPath, "utf8");
  const validNames = new Set(modules.map((m) => m.name));

  const { result, removed } = removeExtraConfigSubmodules(content, validNames);

  if (removed.length === 0) {
    console.log("  .git/config: no extra submodule entries");
    return;
  }

  await writeFile(configPath, result, "utf8");
  for (const name of removed) {
    console.log(`  .git/config: removed [submodule "${name}"]`);
  }
}
