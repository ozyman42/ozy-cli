import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, validate, serialize, sorted } from "./gitmodules";
import { readGitState } from "./git-state";
import { fixGitConfig, fixModuleDirs, fixIndexGitlinks } from "./fix";
import { printSyncState, printFixes } from "./printer";
import { makeCommand } from "../../../common/command";
import { Ok } from '../../../common/result';

const REPO_ROOT = process.cwd();
const GITMODULES_PATH = resolve(REPO_ROOT, ".gitmodules");

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

  const state = await readGitState(REPO_ROOT, submodulePaths);
  printSyncState(modules, state);

  const appliedFixes = [
    ...await fixGitConfig(REPO_ROOT, modules),
    ...await fixModuleDirs(REPO_ROOT, modules, state.moduleDirs, state.orphanModuleDirs),
    ...await fixIndexGitlinks(REPO_ROOT, modules, state.index),
  ];
  printFixes(appliedFixes);

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