import { Command } from 'commander';
import { Effect, Layer, Option, pipe, Result } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { BunFileSystem } from '@effect/platform-bun';
import { selectFromList } from '@ozyman42/interactive-cli-select';
import { log } from '@/common/log';
import { CLIModules, cliModules } from '@/modules/cli';
import { commonModules, type CommonModules } from '@/modules/common';
import { GitImpl } from '@/modules/cli/git/impl';
import { GitHubImpl } from '@/modules/cli/github/impl';
import { AgentClientImpl } from '@/modules/cli/agent-client/impl';
import { NpmImpl } from '@/modules/cli/npm/impl';
import type { PublishInput } from '@/modules/cli/package/interface';
import { PackageImpl } from '@/modules/cli/package/impl';
import { TemplatesImpl } from '@/modules/cli/templates/impl';
import { OSPlatformImpl } from '@/modules/common/os-platform/impl';
import { SSHConfigImpl } from '@/modules/common/ssh-config/impl';
import { effunct, type EffectGen } from 'effective-modules';
import { using } from '@/common/effective-modules-extensions';

const layerLive = pipe(
  PackageImpl.Layer,
  Layer.provideMerge(NpmImpl.Layer),
  Layer.provideMerge(GitImpl.Layer),
  Layer.provideMerge(GitHubImpl.Layer),
  Layer.provideMerge(AgentClientImpl.Layer),
  Layer.provideMerge(TemplatesImpl.Layer),
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(SSHConfigImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer),
  Layer.provideMerge(FetchHttpClient.layer)
);

/**
 * Reads the package name and git remote from the current directory — both must already exist; this
 * command does not derive, search, or create them from anything else.
 */
function* derivePublishArgs(
  maybePrivateAccessArg: Option.Option<boolean>,
  maybeSkipConfirmationArg: Option.Option<boolean>
): EffectGen<PublishInput, string, CLIModules.Git | CLIModules.Package | CommonModules.OSPlatform> {
  // Effect v3 → v4 shim: @ozyman42/interactive-cli-select's compiled code calls Effect.async, renamed to
  // Effect.callback in v4 (see src/commands/ssh/get-sk-credential.ts for the same workaround).
  (Effect as any).async = (Effect as any).callback;

  const git = yield* cliModules.Git;
  const pkg = yield* cliModules.Package;
  const osPlatform = yield* commonModules.OSPlatform;
  const cwd = yield* osPlatform.getCurrentDirectory();

  const privateAccess = pipe(
    maybePrivateAccessArg,
    Option.getOrElse(() => false)
  );
  const skipConfirmation = pipe(
    maybeSkipConfirmationArg,
    Option.getOrElse(() => false)
  );

  const packageJsonOption = yield* pkg.loadPackageJson(cwd);
  if (Option.isNone(packageJsonOption)) {
    return yield* Effect.fail(`No package.json found in ${cwd} — publish must be run from a package directory`);
  }
  const packageRef = packageJsonOption.value.name;

  const maybeRemote = yield* git.getRemoteOrigin();
  if (Option.isNone(maybeRemote)) {
    return yield* Effect.fail(`No git remote origin configured in ${cwd} — publish requires an existing remote`);
  }
  const remote = maybeRemote.value;

  if (!skipConfirmation) {
    log(`Publish npm package "${packageRef.raw}" from repo "${remote.formatted}"?`);
    const choice = yield* selectFromList({
      options: ["Yes", "No"] as const,
      getKey: o => o,
      renderOption: o => o,
    }).pipe(Effect.orDie);
    if (choice === "No") {
      return yield* Effect.fail("Publish cancelled");
    }
  }

  yield* Effect.log(`Using ${packageRef.raw} from package.json and ${remote.formatted} from git remote origin`);
  return { packageRef, remote, privateAccess };
}

export const publish = new Command('publish')
  .description('publish the npm package in the current directory, publishing the first version if it does not exist and setting up trusted publishing. Reads the package name and git remote from the current directory — both must already exist.')
  .option("--private", "Whether the package should be published to npm as private (only works for scoped packages)")
  .option("--yes", "Skip the publish confirmation prompt")
  .action(async ({ private: privateAccessFlag, yes: skipConfirmationFlag }: { private?: boolean; yes?: boolean }) => {
    const result = await Effect.runPromise(
      pipe(
        effunct(derivePublishArgs)(
          Option.fromNullishOr(privateAccessFlag),
          Option.fromNullishOr(skipConfirmationFlag)
        ),
        Effect.flatMap(using(cliModules.Package).publish),
        Effect.provide(layerLive),
        Effect.result
      )
    );
    if (Result.isFailure(result)) {
      log(`✗ ${result.failure}`);
      process.exit(1);
    } else {
      process.exit(0);
    }
  });
