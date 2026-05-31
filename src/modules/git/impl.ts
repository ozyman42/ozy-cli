import { implementing, type EffectGen } from "effective-modules";
import { modules } from "../cli-modules";
import { commonModules } from "../common-modules";
import { $ } from 'bun';
import type { IGit } from "./interface";
import { Effect, Option, pipe } from "effect";
import { rmSync } from "node:fs";
import { TEMP_PUBKEY_PATH } from "../../common/constants";
import { getSSHCommand } from "../../common/ssh";

export class GitImpl extends implementing(modules.Git).uses(commonModules.OSPlatform) implements IGit {
  
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
  *clone(owner: string, repo: string, pubkey: string): EffectGen<void, string> {
    yield* this.dependencies.OSPlatform.writeRestrictedFile(TEMP_PUBKEY_PATH, pubkey);
    const env = {
      ...process.env,
      GIT_SSH_COMMAND: getSSHCommand(TEMP_PUBKEY_PATH)
    };
    const result = Bun.spawnSync(['git', 'clone', `git@github.com:${owner}/${repo}.git`], { stdout: 'inherit', stderr: 'inherit', env });
    rmSync(TEMP_PUBKEY_PATH);
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
}
