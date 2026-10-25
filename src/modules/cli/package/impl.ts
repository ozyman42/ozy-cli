import { Effect, FileSystem, Option, Result, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { log } from "@/common/log";
import { cliModules } from "@/modules/cli";
import { commonModules } from "@/modules/common";
import { NpmPackageWriteAccess } from "../npm/interface";
import type { PublishInput, IPackage } from "./interface";
import {
  validatePackageJson,
  encodePackageJson,
  type PackageJson,
} from "./package-json";

const MINIMUM_NPM_VERSION = "11.10.0";
// Template rendering is disabled for now (see the commented-out call in create()) until ozy moves onto
// the jive project in a more generic form. The installed CLI always runs as the compiled executable
// self-repaired into <packageRoot>/bin/<command> (see command-launcher.js.ejs), so process.execPath
// reliably locates the package root at runtime; src/ ships in full alongside bin/ (see
// generateBasePackageJson's "files"), so this reads real files on disk once re-enabled.
// const PACKAGE_TEMPLATE_DIR = resolve(dirname(process.execPath), "..", "src", "modules/cli/package/package-template");
// const PIPELINE_WORKFLOW_PATH = ".github/workflows/pipeline.yml";

export class PackageImpl extends implementing(cliModules.Package).uses(
  cliModules.Git,
  cliModules.GitHub,
  cliModules.Npm,
  cliModules.Templates,
  commonModules.OSPlatform,
  FileSystem.FileSystem,
) implements IPackage {
  *publish({ packageRef, privateAccess, remote }: PublishInput): EffectGen<void, string> {
    const { Git, GitHub, Npm, OSPlatform } = this.dependencies;
    const cwd = yield* OSPlatform.getCurrentDirectory();

    // setupRepo always needs the ssh form regardless of what protocol `remote` happens to carry (e.g. an
    // existing local remote configured over https).
    const sshRemoteURL = GitHub.getRemote(remote.owner, remote.repo, "ssh").raw;

    // Test some invariants about the inputs at the cost of extra filesystem reads.
    // TODO: is this necessary or can we simply trust that the calling code is honest?
    const packageOption = yield* this.loadPackageJson(cwd);
    if (Option.isNone(packageOption)) {
      return yield* Effect.fail(`Invariant violation: package.json not found; expected cwd package.json with name ${packageRef.raw}`);
    }
    const pkg = packageOption.value;
    if (pkg.name.raw !== packageRef.raw) {
      return yield* Effect.fail(`Invariant violation: cwd package.json name is ${pkg.name.raw}, expected ${packageRef.raw}`);
    }
    const maybeCurrentRemote = yield* Git.getRemoteOrigin();
    if (Option.isNone(maybeCurrentRemote)) {
      return yield* Effect.fail(`Invariant violation: cwd has no origin remote; expected cwd to have origin remote of ${remote.raw}`);
    }
    if (maybeCurrentRemote.value.raw !== remote.raw) {
      return yield* Effect.fail(`Invariant violation: cwd has remote origin of ${maybeCurrentRemote.value.raw}; expected it to be ${remote.raw}`)
    }

    // Confirm we can push to a repo / create it if it doesn't exist.
    const { token, login, user: signingUser, pubkeyPath } = yield* GitHub.signIn(Option.some('repo'));
    const maybeRepoAccess = yield* GitHub.getRepoAccess(token, remote);
    // TODO: in the future we should be pushing and then waiting for the CICD pipeline to finish
    //.      rather than doing a direct publish
    if (Option.isSome(maybeRepoAccess)) {
      const repoAccess = maybeRepoAccess.value;
      if (!repoAccess.canPush) {
        return yield* Effect.fail(`no push access to ${remote.formatted}`);
      }
    } else {
      // Repo doesn't exist yet on GitHub.
      const canCreate = yield* GitHub.canCreateRepo(token, remote.owner);
      if (!canCreate) {
        return yield* Effect.fail(`no permission to create a repo under ${remote.owner} — ask an org admin, or use an owner/repo you can create`);
      }
      yield* Effect.log(`Creating repo ${remote.formatted} on Github`);
      yield* GitHub.createRepo({token, login}, remote);
    }

    // Setup repo for pushes. More important for when we move to a model of letting the repo push
    // to test the actual CI/CD logic rather than publishing directly.
    yield* Git.setupRepo({ dir: cwd, remoteURL: sshRemoteURL, user: signingUser, pubkeyPath });
    
    // First ensure package can be published from local before actually rendering template
    log(`checking npm CLI and package ${packageRef.raw} access...`);
    const npmVersion = yield* Npm.ensureMinimumVersion(MINIMUM_NPM_VERSION);
    log(`  ✓ npm ${npmVersion}`);
    const user = yield* Npm.login();
    log(`  ✓ logged into npm as ${user.username}`);
    const packageAccess = yield* Npm.ensurePackageWriteAccess(user, packageRef);
    log(`  ✓ ${packageAccess.summary}`);

    log('checking npm registry...');
    const latestPublishedVersion = NpmPackageWriteAccess.$match(packageAccess, {
      ExistingPackage: ({ latestVersion }) => Option.some(latestVersion ?? '(unknown)'),
      NewUnscopedPackage: () => Option.none<string>(),
      NewUserScopedPackage: () => Option.none<string>(),
      NewOrganizationScopedPackage: () => Option.none<string>(),
    });
    // TODO: perhaps when a package hasn't been published yet, we should have the upload artifacts
    //       CI/CD logic reach out to Jive to obtain the user's token for an initial publish and then
    //       the upload artifacts step is actually the one responsible for setting the trusted publishing after initial publish is completed

    if (Option.isNone(latestPublishedVersion)) {
      log('  package not yet published — building and creating initial release...');
      /*
      TODO: we'll do template rendering later
      log(`creating ${packageRef.raw} from template`);
      const templateResult = yield* Templates.renderTemplate(PACKAGE_TEMPLATE_DIR, cwd, templateData(packageRef, remote.owner, remote.repo, repositoryUrl));
      if (templateResult.writtenFiles.includes(PIPELINE_WORKFLOW_PATH)) {
        log('  ✓ created .github/workflows/pipeline.yml');
      } else if (templateResult.skippedFiles.includes(PIPELINE_WORKFLOW_PATH)) {
        log('  ✓ .github/workflows/pipeline.yml already exists');
      } else {
        return yield* Effect.fail(`package template did not render ${PIPELINE_WORKFLOW_PATH}`);
      }
      */
      const buildResult = yield* OSPlatform.spawnProcess({
        command: "bun",
        args: ["run", "jive:cicd:build"],
        cwd,
      });
      if (buildResult.exitCode !== 0)
        return yield* Effect.fail(`build failed: ${buildResult.stderr.trim() || buildResult.stdout.trim()}`);

      // The deploy hook publishes: the template owns packing, versioning and dist-tags, so this names the
      // environment and checks the outcome rather than reimplementing any of it. It previously spawned
      // `jive:cicd:` — an incomplete script name — discarded the result, and logged success either way, so
      // nothing was ever actually published by this path.
      // `Npm.login` verifies the token and then strips it from `~/.npmrc`, keeping it in memory only — so
      // the `npm publish` this eventually spawns has no credential on disk to find. Handing it over as npm
      // config in the environment keeps it that way: it never touches the filesystem.
      const publishResult = yield* OSPlatform.spawnProcess({
        command: "bun",
        args: ["run", "jive:cicd:deploy"],
        cwd,
        env: {
          ...process.env,
          JIVE_DEPLOY_ENVIRONMENT: "latest",
          "npm_config_//registry.npmjs.org/:_authToken": user.token,
        },
      });
      if (publishResult.exitCode !== 0)
        return yield* Effect.fail(`publish failed: ${publishResult.stderr.trim() || publishResult.stdout.trim()}`);
      log(`  ✓ published ${packageRef.raw}`);
    } else {
      log(`  ✓ exists (latest v${latestPublishedVersion.value})`);
    }

    log('checking trusted publishing...');
    const trust = yield* Npm.ensureTrustedPublisher({ packageName: packageRef.raw, ownerRepo: remote.formatted, token: user.token });
    log(trust.alreadyConfigured ? '  ✓ already configured' : '  ✓ configured');

    log('setting package access policy...');
    yield* Npm.setPackageAccessPolicy({
      packageName: packageRef.raw,
      token: user.token,
      existingOtp: trust.otp,
      publicAccess: !privateAccess
    });
    log('  ✓ configured');
  }

  *loadPackageJson(dir: string): EffectGen<Option.Option<PackageJson>, string> {
    const fileSystem = this.getDependency(FileSystem.FileSystem);
    const packageJsonPath = `${dir}/package.json`;
    const packageJsonExistsResult = yield* Effect.result(fileSystem.exists(packageJsonPath));
    if (Result.isFailure(packageJsonExistsResult)) {
      return yield* Effect.fail(`Failed to read ${packageJsonPath}: ${packageJsonExistsResult.failure.message}`);
    }
    const packageJsonExists = packageJsonExistsResult.success;
    if (!packageJsonExists) return Option.none();

    const packageJsonResult = yield* Effect.result(fileSystem.readFileString(packageJsonPath));
    if (Result.isFailure(packageJsonResult)) {
      return yield* Effect.fail(`Failed to read ${packageJsonPath}: ${packageJsonResult.failure.message}`);
    }

    return Option.some(yield* validatePackageJson(packageJsonResult.success));
  }

  *writePackageJson(dir: string, packageJson: PackageJson): EffectGen<void, string> {
    const fileSystem = this.getDependency(FileSystem.FileSystem);
    const result = yield* pipe(
      encodePackageJson(packageJson),
      Effect.flatMap(json => fileSystem.writeFileString(`${dir}/package.json`, json)),
      Effect.result
    );
    if (Result.isFailure(result)) {
      return yield* Effect.fail(`Failed to write package.json: ${String(result.failure)}`);
    }
  }

}

// Paired with the commented-out PACKAGE_TEMPLATE_DIR/PIPELINE_WORKFLOW_PATH above and the disabled
// Templates.renderTemplate call in create() — restore together when templating is re-enabled.
// function templateData(packageName: PackageRef, owner: string, repo: string, repositoryUrl: string): Record<string, unknown> {
//   return {
//     packageName: packageName.raw,
//     packageScope: Option.getOrUndefined(packageName.scope),
//     packageBaseName: packageName.packageName,
//     githubOwner: owner,
//     githubRepo: repo,
//     repositoryUrl,
//     npmPackageSpec: NPM_PACKAGE_SPEC,
//   };
// }
