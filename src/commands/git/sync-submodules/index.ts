import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Result } from "effect";
import { parse, validate, serialize, sorted } from "./gitmodules";
import { readGitState } from "./git-state";
import { fixGitConfig, fixModuleDirs, fixIndexGitlinks, type Fix } from "./fix";
import { printSyncState, printFixes } from "./printer";
import { makeCommand } from "@/common/command";

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

  const stateResult = await Effect.runPromise(readGitState(REPO_ROOT, submodulePaths).pipe(Effect.result));
  if (Result.isFailure(stateResult)) {
    console.error(`Error reading git state: ${stateResult.failure}`);
    process.exit(1);
  }
  const state = stateResult.success;
  printSyncState(modules, state);

  const fixResults = await Promise.all([
    Effect.runPromise(fixGitConfig(REPO_ROOT, modules).pipe(Effect.result)),
    Effect.runPromise(fixModuleDirs(REPO_ROOT, modules, state.moduleDirs, state.orphanModuleDirs).pipe(Effect.result)),
    Effect.runPromise(fixIndexGitlinks(REPO_ROOT, modules, state.index).pipe(Effect.result)),
  ]);

  const appliedFixes: Fix[] = [];
  for (const r of fixResults) {
    if (Result.isFailure(r)) {
      console.error(`Error applying fixes: ${r.failure}`);
      process.exit(1);
    }
    appliedFixes.push(...r.success);
  }
  printFixes(appliedFixes);

  const result = serialize(sorted(modules));
  if (result !== content) {
    await writeFile(GITMODULES_PATH, result, "utf8");
    console.log("\nSorted and wrote .gitmodules.");
  }
}

export const syncSubmodules = makeCommand('sync-submodules', 'sync submodules according to .gitmodules', () =>
  Effect.tryPromise({
    try: async () => { await main(); },
    catch: (e) => e instanceof Error ? e.message : String(e),
  })
);
