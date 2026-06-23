import { implementing, type EffectGen } from "effective-modules";
import { cliModules } from "..";
import { commonModules } from "@/modules/common";
import { $ } from 'bun';
import type { IGit, SetupRepoInput } from "./interface";
import { Effect, Option, pipe } from "effect";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SSH_KEYGEN_CMD_PATH, STANDARD_REMOTE_PREFIX } from "@/common/constants";
import { Gitmodules } from "./submodule/gitmodules";
import { readGitState } from "./submodule/git-state";
import { fixGitConfig, fixModuleDirs, fixIndexGitlinks } from "./submodule/fix";
import { printSyncState, printFixes } from "./submodule/printer";

export class GitImpl extends implementing(cliModules.Git).uses(commonModules.OSPlatform, commonModules.SSHConfig) implements IGit {
  private parseOwnerRepo(remote: string): Effect.Effect<{ owner: string; repo: string }, string> {
    const sshMatch = remote.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) return Effect.succeed({ owner: sshMatch[1]!, repo: sshMatch[2]! });
    const httpsMatch = remote.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return Effect.succeed({ owner: httpsMatch[1]!, repo: httpsMatch[2]! });
    return Effect.fail(`Cannot parse owner/repo from remote: ${remote}`);
  }
  
  *resolveOwnerAndRepo(maybeOwnerAndRepo: Option.Option<string>): EffectGen<{ owner: string; repo: string; }, string> {
    if (Option.isSome(maybeOwnerAndRepo)) {
      const parts = maybeOwnerAndRepo.value.split('/');
      const [owner, repo] = parts;
      if (parts.length !== 2 || !owner || !repo)
        return yield* Effect.fail(`Cannot parse remote error: Expected "owner/repo", got "${maybeOwnerAndRepo.value}"`);
      return { owner, repo };
    }

    if (!(yield* this.isGitRepository())) {
      yield* Effect.fail(`not in git repo: Current directory is not a git repository`);
    }

    const remoteOption = yield* this.getRemoteOrigin();
    if (Option.isNone(remoteOption)) {
      return yield* Effect.fail(`no remote origin: No remote.origin.url — pass owner/repo as argument to clone instead`);
    }

    return yield* this.parseOwnerRepo(remoteOption.value);
  }
  *isGitRepository(): EffectGen<boolean> {
    return yield* pipe(
      Effect.tryPromise(async () => {
        await $`git rev-parse --is-inside-work-tree`.quiet();
        return true;
      }),
      Effect.catchTag("UnknownError", () => Effect.succeed(false))
    );
  }
  *getRemoteOrigin(): EffectGen<Option.Option<string>> {
    return yield* pipe(
      Effect.tryPromise(async() => {
        return Option.some((await $`git config --get remote.origin.url`.quiet()).text().trim());
      }),
      Effect.catchTag("UnknownError", () => Effect.succeed(Option.none()))
    )
  }
  *clone(owner: string, repo: string): EffectGen<void, string> {
    const result = Bun.spawnSync(['git', 'clone', '--recurse-submodules', `${STANDARD_REMOTE_PREFIX}${owner}/${repo}.git`], { stdout: 'inherit', stderr: 'inherit' });
    if (result.exitCode !== 0)
      return yield* Effect.fail(`git clone failed with exit code ${result.exitCode}`);
    process.chdir(`./${repo}`);
  }
  *setLocalConfig(key: string, value: string): EffectGen<void, string> {
    yield* Effect.tryPromise({
      try: async () => { await $`git config --local ${key} ${value}`.quiet(); },
      catch: (e) => `git config ${key}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  private *configureRepo({ dir, remoteURL, user, pubkeyPath }: SetupRepoInput): EffectGen<void, string> {
    yield* Effect.log(`Configuring ${dir}`);
    yield* Effect.tryPromise({
      try: async () => {
        const configs: [string, string][] = [
          ['remote.origin.url', remoteURL],
          ['user.name', user.name],
          ['user.email', user.email],
          ['user.signingkey', pubkeyPath],
          ['gpg.format', 'ssh'],
          ['gpg.ssh.program', SSH_KEYGEN_CMD_PATH],
          ['commit.gpgsign', 'true'],
          ['tag.gpgsign', 'true'],
        ];
        for (const [k, v] of configs) {
          const r = Bun.spawnSync(['git', 'config', '--local', k, v], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
          if (r.exitCode !== 0) {
            const err = new TextDecoder().decode(r.stderr);
            throw new Error(`git config ${k} failed: ${err.trim()}`);
          }
        }
      },
      catch: (e) => e instanceof Error ? e.message : String(e),
    });
  }
  private *syncSubmoduleState(repoRoot: string): EffectGen<Gitmodules, string> {
    const gitmodules = yield* Gitmodules.fromRepoRoot(repoRoot);
    if (gitmodules.list.length === 0) return gitmodules;
    const submodulePaths = gitmodules.list.map(m => m.path);
    const state = yield* readGitState(repoRoot, submodulePaths);
    printSyncState(gitmodules, state);
    const fixResults = yield* Effect.all(
      [
        fixGitConfig(repoRoot, gitmodules),
        fixModuleDirs(repoRoot, gitmodules, state.moduleDirs, state.orphanModuleDirs),
        fixIndexGitlinks(repoRoot, gitmodules, state.index),
      ],
      { concurrency: "unbounded" },
    );
    printFixes(fixResults.flat());
    return gitmodules;
  }
  *setupRepo(input: SetupRepoInput): EffectGen<void, string> {
    yield* this.configureRepo(input);
    if (!existsSync(resolve(input.dir, '.gitmodules'))) return;
    const gitmodules = yield* this.syncSubmoduleState(input.dir);
    for (const m of gitmodules.list) {
      const subDir = resolve(input.dir, m.path);
      if (!existsSync(subDir)) continue;
      yield* this.setupRepo({
        dir: subDir,
        remoteURL: m.url,
        user: input.user,
        pubkeyPath: input.pubkeyPath
      });
    }
  }
}
