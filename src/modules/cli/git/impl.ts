import { effunct, implementing, type EffectGen } from "effective-modules";
import { cliModules } from "..";
import { commonModules } from "@/modules/common";
import type { IGit, Remote, SetupRepoInput } from "./interface";
import { Effect, Option, Result } from "effect";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SSH_KEYGEN_CMD_PATH, STANDARD_REMOTE_PREFIX } from "@/common/constants";
import { Gitmodules } from "./submodule/gitmodules";
import { readGitState } from "./submodule/git-state";
import { fixGitConfig, fixModuleDirs, fixIndexGitlinks } from "./submodule/fix";
import { printSyncState, printFixes } from "./submodule/printer";

export class GitImpl extends implementing(cliModules.Git).uses(commonModules.OSPlatform, commonModules.SSHConfig) implements IGit {
  private *parseRemote(raw: string): EffectGen<Remote, string> {
    const remote = raw.trim();
    const sshMatch = remote.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      const [owner, repo] = [sshMatch[1]!, sshMatch[2]!];
      return { raw: remote, protocol: "ssh", owner, repo, formatted: `${owner}/${repo}` };
    }

    const sshUrlMatch = remote.match(/^ssh:\/\/(?:git@)?[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshUrlMatch) {
      const [owner, repo] = [sshUrlMatch[1]!, sshUrlMatch[2]!];
      return { raw: remote, protocol: "ssh", owner, repo, formatted: `${owner}/${repo}` };
    }

    const httpMatch = remote.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpMatch) {
      const [owner, repo] = [httpMatch[1]!, httpMatch[2]!];
      return { raw: remote, protocol: "http", owner, repo, formatted: `${owner}/${repo}` };
    }

    return yield* Effect.fail(`InvalidRemoteOrigin: cannot parse remote.origin.url "${remote}"`);
  }
  *resolveOwnerAndRepo(maybeOwnerAndRepo: Option.Option<string>): EffectGen<Remote, string> {
    if (Option.isSome(maybeOwnerAndRepo)) {
      const parts = maybeOwnerAndRepo.value.split('/');
      const [owner, repo] = parts;
      if (parts.length !== 2 || !owner || !repo)
        return yield* Effect.fail(`Cannot parse remote error: Expected "owner/repo", got "${maybeOwnerAndRepo.value}"`);
      return {
        owner,
        repo,
        formatted: `${owner}/${repo}`,
        // TODO; this is tied to github at the moment. Need to change that
        raw: `${STANDARD_REMOTE_PREFIX}${owner}/${repo}.git`,
        protocol: "ssh",
      };
    }

    if (!(yield* this.isGitRepository())) {
      yield* Effect.fail(`not in git repo: Current directory is not a git repository`);
    }

    const remoteOption = yield* this.getRemoteOrigin();
    if (Option.isNone(remoteOption)) {
      return yield* Effect.fail(`no remote origin: No remote.origin.url — pass owner/repo as argument to clone instead`);
    }

    return remoteOption.value;
  }
  *isGitRepository(): EffectGen<boolean> {
    const runResult = yield* Effect.result(effunct(this.dependencies.OSPlatform.spawnProcess)({
      command: "git",
      args: ["rev-parse", "--is-inside-work-tree"],
    }));
    if (Result.isFailure(runResult)) return false;
    return runResult.success.exitCode === 0;
  }
  *getRemoteOrigin(): EffectGen<Option.Option<Remote>, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "git",
      args: ["config", "--get", "remote.origin.url"],
    });
    if (result.exitCode !== 0) return Option.none();
    const remote = yield* this.parseRemote(result.stdout.trim());
    return Option.some(remote);
  }
  *init(): EffectGen<void, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "git",
      args: ["init"],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0)
      return yield* Effect.fail(`git init failed with exit code ${result.exitCode}`);
  }
  *clone(remote: Remote): EffectGen<void, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "git",
      args: ["clone", "--recurse-submodules", remote.raw],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0)
      return yield* Effect.fail(`git clone failed with exit code ${result.exitCode}`);
    yield* this.dependencies.OSPlatform.changeDirectory(`./${remote.repo}`);
  }
  *setLocalConfig(key: string, value: string): EffectGen<void, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "git",
      args: ["config", "--local", key, value],
    });
    if (result.exitCode !== 0)
      return yield* Effect.fail(`git config ${key}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
  private *configureRepo({ dir, remoteURL, user, pubkeyPath }: SetupRepoInput): EffectGen<void, string> {
    yield* Effect.log(`Configuring ${dir}`);
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
    for (const [key, value] of configs) {
      const result = yield* this.dependencies.OSPlatform.spawnProcess({
        command: "git",
        args: ["config", "--local", key, value],
        cwd: dir,
      });
      if (result.exitCode !== 0)
        return yield* Effect.fail(`git config ${key} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
  }
  private *syncSubmoduleState(repoRoot: string, topLevelRoot: string): EffectGen<Gitmodules, string> {
    const gitmodules = yield* Gitmodules.fromRepoRoot(repoRoot);
    if (gitmodules.list.length === 0) return gitmodules;
    const submodulePaths = gitmodules.list.map(m => m.path);
    // TODO: we should be providing this.context rather than passing in implementations
    //.      directly
    const state = yield* readGitState(this.dependencies.OSPlatform, repoRoot, submodulePaths);
    printSyncState(gitmodules, state);
    const fixResults = yield* Effect.all(
      [
        effunct(fixGitConfig)(repoRoot, gitmodules),
        effunct(fixModuleDirs)(this.dependencies.OSPlatform, repoRoot, gitmodules, state.moduleDirs, state.orphanModuleDirs, topLevelRoot),
        effunct(fixIndexGitlinks)(this.dependencies.OSPlatform, repoRoot, gitmodules, state.index),
      ],
      { concurrency: "unbounded" },
    );
    printFixes(fixResults.flat());
    return gitmodules;
  }
  *setupRepo(input: SetupRepoInput): EffectGen<void, string> {
    yield* this.setupRepoAt(input, input.dir);
  }
  private *setupRepoAt(input: SetupRepoInput, topLevelRoot: string): EffectGen<void, string> {
    yield* this.configureRepo(input);
    if (!existsSync(resolve(input.dir, '.gitmodules'))) return;
    const gitmodules = yield* this.syncSubmoduleState(input.dir, topLevelRoot);
    for (const m of gitmodules.list) {
      const subDir = resolve(input.dir, m.path);
      if (!existsSync(subDir)) continue;
      yield* this.setupRepoAt({
        dir: subDir,
        remoteURL: m.url,
        user: input.user,
        pubkeyPath: input.pubkeyPath
      }, topLevelRoot);
    }
  }
}
