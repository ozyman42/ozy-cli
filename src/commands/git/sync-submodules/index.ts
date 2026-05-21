import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, validate, serialize, sorted, type Gitmodules } from "./gitmodules";
import { readGitState, type GitState } from "./git-state";
import { fixGitConfig, fixModuleDirs, fixIndexGitlinks } from "./fix";
import {
  PrintableItem, GhostItem,
  GitmodulesEntryItem, GitConfigEntryItem, ModuleDirItem, IndexGitlinkItem, WorkingTreeItem,
} from "./printer";
import { makeCommand } from "../../../common/command";
import { Ok } from '../../../common/result';

const REPO_ROOT = process.cwd();
const GITMODULES_PATH = resolve(REPO_ROOT, ".gitmodules");

function buildSections(modules: Gitmodules, state: GitState) {
  const byName = new Map(modules.map((m) => [m.name, m]));
  const byPath = new Map(modules.map((m) => [m.path, m]));

  // .gitmodules
  const gitmodulesItems = modules.map((m) => new GitmodulesEntryItem(m));

  // .git/config
  const seenConfigNames = new Set<string>();
  const configItems: PrintableItem[] = state.config.map((e) => {
    const isDuplicate = seenConfigNames.has(e.name);
    seenConfigNames.add(e.name);
    return new GitConfigEntryItem(e, byName.get(e.name), isDuplicate);
  });
  for (const m of modules) {
    if (!seenConfigNames.has(m.name))
      configItems.push(new GhostItem(`[${m.name}]`, "missing from .git/config"));
  }

  // .git/modules/
  const seenModulePaths = new Set<string>();
  const moduleDirItems: PrintableItem[] = state.moduleDirs.map((d) => {
    seenModulePaths.add(d.relativePath);
    return new ModuleDirItem(d, byPath.get(d.relativePath));
  });
  for (const m of modules) {
    if (!seenModulePaths.has(m.path))
      moduleDirItems.push(new GhostItem(m.path, "missing from .git/modules/"));
  }

  // index
  const seenIndexPaths = new Set<string>();
  const indexItems: PrintableItem[] = state.index.map((e) => {
    seenIndexPaths.add(e.path);
    return new IndexGitlinkItem(e, byPath.has(e.path));
  });
  for (const m of modules) {
    if (!seenIndexPaths.has(m.path))
      indexItems.push(new GhostItem(m.path, "missing from index"));
  }

  // working tree
  const workingTreeItems = state.workingTree.map((e) => new WorkingTreeItem(e));

  return { gitmodulesItems, configItems, moduleDirItems, indexItems, workingTreeItems };
}

async function main() {
  const content = await readFile(GITMODULES_PATH, "utf8");
  const modules = parse(content);

  const errors = validate(modules, REPO_ROOT);
  if (errors.length) {
    console.error("Validation errors in .gitmodules:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const submodulePaths = modules.map((m) => m.path);

  console.log("=== fixing ===");
  await fixGitConfig(REPO_ROOT, modules);
  const preFixState = await readGitState(REPO_ROOT, submodulePaths);
  await fixModuleDirs(REPO_ROOT, modules, preFixState.moduleDirs);
  await fixIndexGitlinks(REPO_ROOT, modules);

  const state = await readGitState(REPO_ROOT, submodulePaths);
  const { gitmodulesItems, configItems, moduleDirItems, indexItems, workingTreeItems } = buildSections(modules, state);

  console.log("=== .gitmodules ===");
  for (const item of gitmodulesItems) item.print();
  PrintableItem.printGroup(".git/config submodule entries", configItems);
  PrintableItem.printGroup(".git/modules/ git dirs", moduleDirItems);
  PrintableItem.printGroup("index gitlinks", indexItems);
  PrintableItem.printGroup("working tree .git entries", workingTreeItems);

  const result = serialize(sorted(modules));
  if (result !== content) {
    await writeFile(GITMODULES_PATH, result, "utf8");
    console.log("\nSorted and wrote .gitmodules.");
  }
}

export const syncSubmodules = makeCommand('sync-submodules', 'sync submodules according to .gitmodules', async () => {
  await main();
  return Ok(true);
});