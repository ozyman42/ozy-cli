import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { Effect, Option } from 'effect';
import { makeCommand } from '../../../common/command';
import { log } from '../../../common/log';
import { acquireToken } from './npm-auth';
import { fetchPackageInfo } from './package-registry';
import { addTrustedPublisher, setPackageAccessPolicy } from './trusted-publishing';
import { checkGitHubAccess } from './git-remote';
import { workflowExists, createWorkflow } from './workflow';
import { validatePackageJson } from './package-json-validate';

enum SetupError {
  NoGitRepo = 'NoGitRepo',
  NoPackageJson = 'NoPackageJson',
  InvalidPackageJson = 'InvalidPackageJson',
  NpmNotFound = 'NpmNotFound',
  GhNotFound = 'GhNotFound',
  NotLoggedIn = 'NotLoggedIn',
  NoGitRemote = 'NoGitRemote',
  RepoNotFound = 'RepoNotFound',
  NoWriteAccess = 'NoWriteAccess',
  BuildFailed = 'BuildFailed',
  PublishFailed = 'PublishFailed',
  TrustedPublishingFailed = 'TrustedPublishingFailed',
  AccessPolicyFailed = 'AccessPolicyFailed',
}

export const setup = makeCommand('setup', 'configure a new npm package for publishing', () =>
  Effect.gen(function* () {
    const cwd = process.cwd();

    // 1. npm
    log('checking npm...');
    const npmCheck = yield* Effect.promise(() => $`which npm`.quiet().nothrow());
    if (npmCheck.exitCode !== 0)
      yield* Effect.fail(`${SetupError.NpmNotFound}: "npm" not found in PATH — install Node.js from nodejs.org`);
    const npmVersion = (yield* Effect.promise(() => $`npm --version`.quiet().nothrow())).stdout.toString().trim();
    const [major, minor] = npmVersion.split('.').map(Number);
    if (major < 11 || (major === 11 && minor < 10))
      yield* Effect.fail(`${SetupError.NpmNotFound}: npm ${npmVersion} is too old — "npm trust" requires 11.10.0+ (run "npm install -g npm")`);
    const { token: npmToken, user: npmUser } = yield* acquireToken().pipe(
      Effect.mapError(e => `${SetupError.NotLoggedIn}: npm authentication failed: ${e}`)
    );
    log(`  ✓ logged in as ${npmUser}`);

    // 2. GitHub CLI
    log('checking GitHub...');
    const ghCheck = yield* Effect.promise(() => $`which gh`.quiet().nothrow());
    if (ghCheck.exitCode !== 0)
      yield* Effect.fail(`${SetupError.GhNotFound}: "gh" not found in PATH — install GitHub CLI from cli.github.com`);
    let ghUser = yield* Effect.promise(() => $`gh api user --jq .login`.quiet().nothrow());
    if (ghUser.exitCode !== 0) {
      log('  not logged in — opening gh auth login...');
      yield* Effect.promise(() => $`gh auth login`.nothrow());
      ghUser = yield* Effect.promise(() => $`gh api user --jq .login`.quiet().nothrow());
    }
    if (ghUser.exitCode !== 0)
      yield* Effect.fail(`${SetupError.NotLoggedIn}: not logged into GitHub — run "gh auth login"`);
    log(`  ✓ logged in as ${ghUser.stdout.toString().trim()}`);

    // 3. git repo root
    log('checking git repo...');
    if (!existsSync(`${cwd}/.git`))
      yield* Effect.fail(`${SetupError.NoGitRepo}: current directory is not a git repository — run "git init" first`);
    log('  ✓ git repo');

    // 4. package.json — read and fatal-check
    log('checking package.json...');
    const pkgFile = Bun.file(`${cwd}/package.json`);
    if (!(yield* Effect.promise(() => pkgFile.exists())))
      yield* Effect.fail(`${SetupError.NoPackageJson}: no package.json found — run this command from a package directory`);
    let pkg: any = yield* Effect.tryPromise({
      try: () => pkgFile.json(),
      catch: () => `${SetupError.InvalidPackageJson}: package.json contains invalid JSON — fix it and retry`,
    });
    const { name } = pkg;
    if (!name)
      yield* Effect.fail(`${SetupError.InvalidPackageJson}: package.json is missing a "name" field`);
    log(`  name: ${name}`);

    const fatal = validatePackageJson(pkg).find(i => i.fatal);
    if (fatal)
      yield* Effect.fail(`${SetupError.InvalidPackageJson}: ${fatal.field}: ${fatal.issue}`);

    // 5. git remote
    log('checking git remote...');
    const remoteOption = yield* Effect.promise(() => getRemoteUrl(cwd));
    if (Option.isNone(remoteOption))
      yield* Effect.fail(`${SetupError.NoGitRemote}: no git remote configured — run "git remote add origin <url>" first`);
    const remote = (remoteOption as Option.Some<string>).value;
    log(`  remote: ${remote}`);
    const accessOption = yield* Effect.promise(() => checkGitHubAccess(remote));
    if (Option.isNone(accessOption))
      yield* Effect.fail(`${SetupError.RepoNotFound}: could not reach GitHub repo at ${remote} — check "gh auth status"`);
    const access = (accessOption as Option.Some<{ owner: string; repo: string; canPush: boolean }>).value;
    if (!access.canPush)
      yield* Effect.fail(`${SetupError.NoWriteAccess}: no push access to ${access.owner}/${access.repo} — you need write permissions`);
    const repoHttpsUrl = `https://github.com/${access.owner}/${access.repo}`;
    log(`  ✓ ${access.owner}/${access.repo} (write access confirmed)`);

    // 6. Sync package.json repository URL from git remote; report other non-fatal issues
    const expectedRepoUrl = `git+${repoHttpsUrl}.git`;
    const currentRepoUrl = typeof pkg.repository === 'object' ? pkg.repository?.url : pkg.repository;
    if (currentRepoUrl !== expectedRepoUrl) {
      log('syncing package.json repository URL...');
      log(`  was: ${currentRepoUrl ?? '(missing)'}`);
      pkg = { ...pkg, repository: { type: 'git', url: expectedRepoUrl } };
      yield* Effect.promise(() => Bun.write(`${cwd}/package.json`, JSON.stringify(pkg, null, 2) + '\n'));
      log(`  ✓ set to ${expectedRepoUrl}`);
    }

    const nonFatal = validatePackageJson(pkg).filter(i => !i.fatal);
    if (nonFatal.length > 0) {
      log('package.json issues (fix manually):');
      for (const { field, issue } of nonFatal) log(`  ${field}: ${issue}`);
    }

    // 7. Publish workflow
    log('checking publish workflow...');
    if (!(yield* Effect.promise(() => workflowExists(cwd)))) {
      yield* Effect.promise(() => createWorkflow(cwd));
      log('  ✓ created .github/workflows/publish.yml');
    } else {
      log('  ✓ already exists');
    }

    // 8. npm package — initial publish if not yet on registry
    log('checking npm registry...');
    const infoOption = yield* fetchPackageInfo(name).pipe(
      Effect.mapError(e => `${SetupError.NpmNotFound}: npm registry lookup failed: ${e}`)
    );
    if (Option.isNone(infoOption)) {
      log('  package not yet published — building and creating initial release...');
      const buildResult = yield* Effect.promise(() => $`bun run build`.nothrow());
      if (buildResult.exitCode !== 0)
        yield* Effect.fail(`${SetupError.BuildFailed}: build failed: ${buildResult.stderr.toString().trim()}`);
      const distPkgFile = Bun.file(`${cwd}/dist/package.json`);
      if (!(yield* Effect.promise(() => distPkgFile.exists())))
        yield* Effect.fail(`${SetupError.BuildFailed}: build succeeded but dist/package.json is missing — build script must produce it`);
      yield* Effect.tryPromise({
        try: () => distPkgFile.json(),
        catch: () => `${SetupError.BuildFailed}: dist/package.json exists but contains invalid JSON — check your build script`,
      });
      yield* npmPublish(npmToken).pipe(
        Effect.mapError(e => `${SetupError.PublishFailed}: ${e}`)
      );
      log(`  ✓ published ${name}`);
    } else {
      const version = infoOption.value.latestVersion ?? '(unknown)';
      log(`  ✓ exists (latest v${version})`);
    }

    // 9. Trusted publishing
    log('checking trusted publishing...');
    const ownerRepo = `${access.owner}/${access.repo}`;
    const trust = yield* addTrustedPublisher(name, ownerRepo, npmToken).pipe(
      Effect.mapError(e => `${SetupError.TrustedPublishingFailed}: ${e}`)
    );
    log(trust.alreadyConfigured ? '  ✓ already configured' : '  ✓ configured');

    // 10. Package access policy — require 2FA, disallow automation tokens
    log('setting package access policy...');
    yield* setPackageAccessPolicy(name, npmToken, trust.otp).pipe(
      Effect.mapError(e => `${SetupError.AccessPolicyFailed}: ${e}`)
    );
    log('  ✓ configured');
  })
);

async function getRemoteUrl(cwd: string): Promise<Option.Option<string>> {
  const result = await $`git -C ${cwd} remote get-url origin`.quiet().nothrow();
  if (result.exitCode !== 0) return Option.none();
  return Option.some(result.stdout.toString().trim());
}

function npmPublish(token: string): Effect.Effect<void, string> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(['npm', 'publish', 'dist/', '--access', 'public', '--no-provenance'], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, NODE_AUTH_TOKEN: token },
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) throw new Error('npm publish failed — see output above');
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}
