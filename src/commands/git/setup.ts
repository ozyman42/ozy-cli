import { Command } from 'commander';
import { Effect, Layer, Option, pipe } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { log } from '@/common/log';
import { cliModules, type CLIModules } from '@/modules/cli';
import { commonModules, type CommonModules } from '@/modules/common';
import { effunct, type EffectGen } from 'effective-modules';
import { GitImpl } from '@/modules/cli/git/impl';
import { GitHubImpl } from '@/modules/cli/github/impl';
import { AgentClientImpl } from '@/modules/cli/agent-client/impl';
import { OSPlatformImpl } from '@/modules/common/os-platform/impl';
import { SSHConfigImpl } from '@/modules/common/ssh-config/impl';
import { BunFileSystem } from "@effect/platform-bun";

type AllModules = CLIModules.Git | CLIModules.GitHub | CLIModules.AgentClient | CommonModules.SSHConfig | CommonModules.OSPlatform;

function* gitSetup(ownerRepoArg?: string): EffectGen<void, string, AllModules> {
  const git = yield* cliModules.Git;
  const github = yield* cliModules.GitHub;
  const osPlatform = yield* commonModules.OSPlatform;

  const remote = yield* git.resolveOwnerAndRepo(Option.fromNullishOr(ownerRepoArg));

  log(`Setting up ${remote.formatted}`);

  const { user, pubkeyPath } = yield* github.signIn(Option.none());

  if (ownerRepoArg !== undefined) {
    yield* git.clone(remote);
    log(`✓ Cloned into ${remote.repo}/`);
  }

  log('\nSetting git config:');
  yield* git.setupRepo({
    dir: yield* osPlatform.getCurrentDirectory(),
    // setupRepo always needs the ssh form regardless of what protocol `remote` happens to carry.
    remoteURL: github.getRemote(remote.owner, remote.repo, "ssh").raw,
    user,
    pubkeyPath,
  });

  log(`\n✓ Setup complete for ${remote.formatted}`);
}

const layerLive = pipe(
  GitImpl.Layer,
  Layer.provideMerge(GitHubImpl.Layer),
  Layer.provideMerge(AgentClientImpl.Layer),
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(SSHConfigImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer),
  Layer.provideMerge(FetchHttpClient.layer)
)

export const setup = new Command('setup')
  .description('setup verified git commits for current repo')
  .argument('[owner/repo]', 'GitHub repo to clone and set up (omit if already in a repo with a remote)')
  .action(async (ownerRepo?: string) => {
    function* program(): EffectGen<void> {
      yield* pipe(
        effunct(gitSetup)(ownerRepo),
        Effect.provide(layerLive),
        Effect.catch(err => Effect.sync(() => {
          log(`✗ ${err}`);
        }))
      );
    }
    await Effect.runPromise(effunct(program)());
    process.exit();
  });
