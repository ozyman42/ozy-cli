import { Command } from 'commander';
import { Effect, Layer, Option, pipe } from 'effect';
import { log } from '../../common/log';
import { Action, type SessionResult } from '../../modules/session/interface';
import { modules, type Modules } from '../../modules/cli-modules';
import { commonModules, CommonModules } from '../../modules/common-modules';
import { effunct, type EffectGen } from 'effective-modules';
import { GitImpl } from '../../modules/git/impl';
import { GitHubImpl } from '../../modules/github/impl';
import { AgentClientImpl } from '../../modules/agent-client/impl';
import { OSPlatformImpl } from '../../modules/os-platform/impl';
import { FUTURE_TOOL_NAME } from '../../common/constants';
import { BunFileSystem } from "@effect/platform-bun";
import { getSSHCommand, getSSHKeygenCommand } from '../../common/ssh';
import { mkdirSync } from 'node:fs';
import { resolve } from "node:path";

type AllModules = Modules.Git | Modules.GitHub | Modules.AgentClient | CommonModules.OSPlatform;

const GITHUB_CLIENT_ID = 'Ov23liKYxk1Ag7SsNhbP';
const GITHUB_CLIENT_SECRET = 'e2901fbe93c591e7a53a903e70490ff87e998159';
const OAUTH_SCOPES = 'repo read:user user:email write:ssh_signing_key';
const KEY_PREFIX = `${FUTURE_TOOL_NAME}:`;

export enum GitSetupError {
  NotInGitRepositoryError = 'NotInGitRepositoryError',
  NoRemoteOriginError = 'NoRemoteOriginError',
  OAuthFailedError = 'OAuthFailedError',
  GitHubUserFetchFailedError = 'GitHubUserFetchFailedError',
  RepoAccessDeniedError = 'RepoAccessDeniedError',
  MultipleJiveSigningKeysError = 'MultipleJiveSigningKeysError',
  AgentStartFailedError = 'AgentStartFailedError',
  AgentProcedureFailedError = 'AgentProcedureFailedError',
  GitCloneFailedError = 'GitCloneFailedError',
  GitConfigFailedError = 'GitConfigFailedError',
}

function* gitSetup(ownerRepoArg?: string): Effect.fn.Return<void, string, AllModules> {
  const git = yield* modules.Git;
  const github = yield* modules.GitHub;
  const agentClient = yield* modules.AgentClient;
  const osPlatform = yield* commonModules.OSPlatform;
  const isCloneMode = ownerRepoArg !== undefined;

  // 1. Parse owner/repo
  const { owner, repo } = yield* git.resolveOwnerAndRepo(Option.fromNullishOr(ownerRepoArg));
  log(`Setting up ${owner}/${repo}`);

  // 2. GitHub OAuth
  const token = yield* github.authorize(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, OAUTH_SCOPES);
  log('✓ Authorized with GitHub');

  // 3. Fetch user info
  const ghUser = yield* github.getUser(token);
  log(`  Logged in as: ${ghUser.login} <${ghUser.email}>`);

  // 4. Verify repo access
  const {id: repoId} = yield* github.checkRepoAccess(token, owner, repo);
  log(`✓ Confirmed access to ${owner}/${repo}`);

  // 5. Check GitHub signing keys for jive: prefix
  const signingKeys = yield* github.getSigningKeys(token);
  const toolKeys = signingKeys.filter(k => k.title.startsWith(KEY_PREFIX));
  if (toolKeys.length > 1)
    return yield* Effect.fail(`${GitSetupError.MultipleJiveSigningKeysError}: Found ${toolKeys.length} signing keys with "${KEY_PREFIX}" prefix — expected at most 1`);
  let maybeKey: Option.Option<{ credentialId: string; pubkey: string }> = Option.none();
  if (toolKeys[0]) {
    const toolKey = toolKeys[0];
    maybeKey = Option.some({
      credentialId: toolKey.title.slice(KEY_PREFIX.length),
      pubkey: toolKey.key,
    });
  }

  // 6. Ensure agent is running
  yield* agentClient.ensureRunning();

  // 7. Call agent to get/verify keys
  const { signingPubkey, credentialId, deployPubkey } = yield* agentClient.usingClient(function* (client): EffectGen<SessionResult, string> {
    return yield* pipe(
      client.DeclareSession({
        context: {
          repo: { owner, name: repo, id: repoId },
          user: { login: ghUser.login },
        },
        actions: [Action.Push, Action.Pull, Action.Commit],
        existingKey: Option.getOrUndefined(maybeKey),
      }),
      Effect.mapError(e => `${GitSetupError.AgentProcedureFailedError}: ${String(e)}`)
    );
  });
  const keyTitle = `${KEY_PREFIX}${credentialId}`;

  // 8. Register signing key on GitHub if not already present
  if (Option.isNone(maybeKey)) {
    yield* github.addSigningKey(token, keyTitle, signingPubkey);
    log(`✓ Registered GitHub signing key: ${keyTitle}`);
  }

  // 9. Register deploy key for this repo if not already present
  const deployKeys = yield* github.listDeployKeys(token, owner, repo);
  if (deployKeys.some(k => k.key === deployPubkey)) {
    log(`  Deploy key already registered for ${owner}/${repo}`);
  } else {
    yield* github.addDeployKey(token, owner, repo, keyTitle, deployPubkey);
    log(`✓ Registered deploy key for ${owner}/${repo}`);
  }

  // 10. Clone if in clone mode
  if (isCloneMode) {
    yield* git.clone(owner, repo, deployPubkey);
    log(`✓ Cloned into ${repo}/`);
  }

  // 11. Write public keyfile
  const projectConfigDir = resolve(process.cwd(), `.${FUTURE_TOOL_NAME}`);
  const deployPubkeyFilename = resolve(projectConfigDir, 'key.pub');
  mkdirSync(projectConfigDir);
  yield* osPlatform.writeRestrictedFile(deployPubkeyFilename, deployPubkey);

  // 12. Set local git config
  const gitConfigs: [string, string][] = [
    ['remote.origin.url', `git@github.com:${owner}/${repo}.git`],
    ['user.name', ghUser.login],
    ['user.email', ghUser.email],
    ['user.signingkey', signingPubkey],
    ['core.sshCommand', getSSHCommand(deployPubkeyFilename)],
    ['gpg.format', 'ssh'],
    ['gpg.ssh.program', getSSHKeygenCommand()],
    ['commit.gpgsign', 'true'],
    ['tag.gpgsign', 'true'],
  ];

  log('\nSetting git config:');
  for (const [k, v] of gitConfigs) {
    yield* git.setLocalConfig(k, v);
  }

  log(`\n✓ Setup complete for ${owner}/${repo}`);
}

const layerLive = pipe(
  GitImpl.Layer,
  Layer.provideMerge(GitHubImpl.Layer),
  Layer.provideMerge(AgentClientImpl.Layer),
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer)
)

export const setup = new Command('setup')
  .description('setup verified git commits for current repo')
  .argument('[owner/repo]', 'GitHub repo to clone and set up (omit if already in a repo with a remote)')
  .action(async (ownerRepo?: string) => {
    function* program() {
      yield* pipe(
        effunct(gitSetup)(ownerRepo),
        Effect.provide(layerLive),
        Effect.catch(err => Effect.gen(function* () {
          log(`✗ ${err}`);
        }))
      );
    }
    await Effect.runPromise(Effect.gen(program));
    process.exit();
  });
