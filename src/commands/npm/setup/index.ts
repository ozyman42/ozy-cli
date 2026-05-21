import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { makeCommand } from '../../../common/command';
import { Ok, Err } from '../../../common/result';
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
}

export const setup = makeCommand('setup', 'configure a new npm package for publishing', async () => {
  const cwd = process.cwd();

  // 1. npm
  log('checking npm...');
  const npmCheck = await $`which npm`.quiet().nothrow();
  if (npmCheck.exitCode !== 0) {
    return Err(SetupError.NpmNotFound, '"npm" not found in PATH — install Node.js from nodejs.org');
  }
  const npmVersion = (await $`npm --version`.quiet().nothrow()).stdout.toString().trim();
  const [major, minor] = npmVersion.split('.').map(Number);
  if (major < 11 || (major === 11 && minor < 10)) {
    return Err(SetupError.NpmNotFound, `npm ${npmVersion} is too old — "npm trust" requires 11.10.0+ (run "npm install -g npm")`);
  }
  let npmToken: string, npmUser: string;
  try {
    ({ token: npmToken, user: npmUser } = await acquireToken());
  } catch (e: any) {
    return Err(SetupError.NotLoggedIn, `npm authentication failed: ${e.message}`);
  }
  log(`  ✓ logged in as ${npmUser}`);

  // 2. GitHub CLI
  log('checking GitHub...');
  const ghCheck = await $`which gh`.quiet().nothrow();
  if (ghCheck.exitCode !== 0) {
    return Err(SetupError.GhNotFound, '"gh" not found in PATH — install GitHub CLI from cli.github.com');
  }
  let ghUser = await $`gh api user --jq .login`.quiet().nothrow();
  if (ghUser.exitCode !== 0) {
    log('  not logged in — opening gh auth login...');
    await $`gh auth login`.nothrow();
    ghUser = await $`gh api user --jq .login`.quiet().nothrow();
  }
  if (ghUser.exitCode !== 0) {
    return Err(SetupError.NotLoggedIn, 'not logged into GitHub — run "gh auth login"');
  }
  log(`  ✓ logged in as ${ghUser.stdout.toString().trim()}`);

  // 3. git repo root
  log('checking git repo...');
  if (!existsSync(`${cwd}/.git`)) {
    return Err(SetupError.NoGitRepo, 'current directory is not a git repository — run "git init" first');
  }
  log('  ✓ git repo');

  // 4. package.json — read and fatal-check
  log('checking package.json...');
  const pkgFile = Bun.file(`${cwd}/package.json`);
  if (!await pkgFile.exists()) {
    return Err(SetupError.NoPackageJson, 'no package.json found — run this command from a package directory');
  }
  let pkg: any;
  try {
    pkg = await pkgFile.json();
  } catch {
    return Err(SetupError.InvalidPackageJson, 'package.json contains invalid JSON — fix it and retry');
  }
  const { name } = pkg;
  if (!name) {
    return Err(SetupError.InvalidPackageJson, 'package.json is missing a "name" field');
  }
  log(`  name: ${name}`);

  const fatal = validatePackageJson(pkg).find(i => i.fatal);
  if (fatal) {
    return Err(SetupError.InvalidPackageJson, `${fatal.field}: ${fatal.issue}`);
  }

  // 5. git remote
  log('checking git remote...');
  const remote = await getRemoteUrl(cwd);
  if (!remote) {
    return Err(SetupError.NoGitRemote, 'no git remote configured — run "git remote add origin <url>" first');
  }
  log(`  remote: ${remote}`);
  const access = await checkGitHubAccess(remote);
  if (!access) {
    return Err(SetupError.RepoNotFound, `could not reach GitHub repo at ${remote} — check "gh auth status"`);
  }
  if (!access.canPush) {
    return Err(SetupError.NoWriteAccess, `no push access to ${access.owner}/${access.repo} — you need write permissions`);
  }
  const repoHttpsUrl = `https://github.com/${access.owner}/${access.repo}`;
  log(`  ✓ ${access.owner}/${access.repo} (write access confirmed)`);

  // 6. Sync package.json repository URL from git remote; report other non-fatal issues
  const expectedRepoUrl = `git+${repoHttpsUrl}.git`;
  const currentRepoUrl = typeof pkg.repository === 'object' ? pkg.repository?.url : pkg.repository;
  if (currentRepoUrl !== expectedRepoUrl) {
    log('syncing package.json repository URL...');
    log(`  was: ${currentRepoUrl ?? '(missing)'}`);
    pkg = { ...pkg, repository: { type: 'git', url: expectedRepoUrl } };
    await Bun.write(`${cwd}/package.json`, JSON.stringify(pkg, null, 2) + '\n');
    log(`  ✓ set to ${expectedRepoUrl}`);
  }

  const nonFatal = validatePackageJson(pkg).filter(i => !i.fatal);
  if (nonFatal.length > 0) {
    log('package.json issues (fix manually):');
    for (const { field, issue } of nonFatal) log(`  ${field}: ${issue}`);
  }

  // 7. Publish workflow
  log('checking publish workflow...');
  if (!await workflowExists(cwd)) {
    await createWorkflow(cwd);
    log('  ✓ created .github/workflows/publish.yml');
  } else {
    log('  ✓ already exists');
  }

  // 8. npm package — initial publish if not yet on registry
  log('checking npm registry...');
  const info = await fetchPackageInfo(name).catch(err => { throw new Error(`npm registry lookup failed: ${err.message}`); });
  if (!info) {
    log('  package not yet published — building and creating initial release...');
    const buildResult = await $`bun run build`.nothrow();
    if (buildResult.exitCode !== 0) {
      throw new Error(`build failed: ${buildResult.stderr.toString().trim()}`);
    }
    const distPkgFile = Bun.file(`${cwd}/dist/package.json`);
    if (!await distPkgFile.exists()) {
      throw new Error('build succeeded but dist/package.json is missing — build script must produce it');
    }
    try {
      await distPkgFile.json();
    } catch {
      throw new Error('dist/package.json exists but contains invalid JSON — check your build script');
    }
    await npmPublish(npmToken);
    log(`  ✓ published ${name}`);
  } else {
    const version = info.latestVersion ?? '(unknown)';
    log(`  ✓ exists (latest v${version})`);
  }

  // 9. Trusted publishing
  log('checking trusted publishing...');
  const ownerRepo = `${access.owner}/${access.repo}`;
  const trust = await addTrustedPublisher(name, ownerRepo, npmToken);
  log(trust.alreadyConfigured ? '  ✓ already configured' : '  ✓ configured');

  // 10. Package access policy — require 2FA, disallow automation tokens
  // Pass along any OTP from step 9 to avoid a second browser prompt.
  log('setting package access policy...');
  await setPackageAccessPolicy(name, npmToken, trust.otp);
  log('  ✓ configured');

  return Ok(true);
});

async function getRemoteUrl(cwd: string): Promise<string | undefined> {
  const result = await $`git -C ${cwd} remote get-url origin`.quiet().nothrow();
  if (result.exitCode !== 0) return undefined;
  return result.stdout.toString().trim();
}

async function npmPublish(token: string): Promise<void> {
  const proc = Bun.spawn(['npm', 'publish', 'dist/', '--access', 'public', '--no-provenance'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, NODE_AUTH_TOKEN: token },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error('npm publish failed — see output above');
}

