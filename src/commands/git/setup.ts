import { Command } from 'commander';
import { Effect, Layer, Option, pipe } from 'effect';
import { log } from '@/common/log';
import { cliModules, type CLIModules } from '@/modules/cli';
import { commonModules, CommonModules } from '@/modules/common';
import { effunct, type EffectGen } from 'effective-modules';
import { GitImpl } from '@/modules/cli/git/impl';
import { GitHubImpl } from '@/modules/cli/github/impl';
import { AgentClientImpl } from '@/modules/cli/agent-client/impl';
import { OSPlatformImpl } from '@/modules/common/os-platform/impl';
import { SSHConfigImpl } from '@/modules/common/ssh-config/impl';
import { AGENT_SOCK_FILE_PATH, FUTURE_TOOL_NAME, SSH_KEYGEN_CMD_PATH } from '../../common/constants';
import { CredentialId } from '@/modules/common/crypto/impl';
import { BunFileSystem } from "@effect/platform-bun";

type AllModules = CLIModules.Git | CLIModules.GitHub | CLIModules.AgentClient | CommonModules.SSHConfig;

const GITHUB_CLIENT_ID = 'Ov23liKYxk1Ag7SsNhbP';
const GITHUB_CLIENT_SECRET = 'e2901fbe93c591e7a53a903e70490ff87e998159';
const OAUTH_SCOPES = 'read:user user:email write:ssh_signing_key write:public_key';
const KEY_PREFIX = `${FUTURE_TOOL_NAME}-`;

function parseCredentialIdFromTitle(title: string): Option.Option<string> {
  const match = title.match(/\(([^)]+)\)$/);
  if (!match) return Option.none();
  return Option.some(match[1]!);
}

function baseKey(pubkey: string): string {
  return pubkey.split(' ').slice(0, 2).join(' ');
}

export enum GitSetupError {
  NotInGitRepositoryError = 'NotInGitRepositoryError',
  NoRemoteOriginError = 'NoRemoteOriginError',
  OAuthFailedError = 'OAuthFailedError',
  GitHubUserFetchFailedError = 'GitHubUserFetchFailedError',
  RepoAccessDeniedError = 'RepoAccessDeniedError',
  MultipleJiveSigningKeysError = 'MultipleJiveSigningKeysError',
  MultipleJiveAuthnKeysError = 'MultipleJiveAuthnKeysError',
  MissingCredentialIdError = 'MissingCredentialIdError',
  SigningAuthnKeyMismatchError = 'SigningAuthnKeyMismatchError',
  AgentStartFailedError = 'AgentStartFailedError',
  AgentProcedureFailedError = 'AgentProcedureFailedError',
  GitCloneFailedError = 'GitCloneFailedError',
  GitConfigFailedError = 'GitConfigFailedError',
}

function* gitSetup(ownerRepoArg?: string): Effect.fn.Return<void, string, AllModules> {
  const git = yield* cliModules.Git;
  const github = yield* cliModules.GitHub;
  const agentClient = yield* cliModules.AgentClient;
  const sshConfig = yield* commonModules.SSHConfig;
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

  // 4. Check GitHub signing keys for <tool name>: prefix
  const signingKeys = yield* github.getSigningKeys(token);
  const toolKeys = signingKeys.filter(k => k.title.startsWith(KEY_PREFIX));
  if (toolKeys.length > 1)
    return yield* Effect.fail(`${GitSetupError.MultipleJiveSigningKeysError}: Found ${toolKeys.length} signing keys with "${KEY_PREFIX}" prefix — expected at most 1`);
  let maybeKey: Option.Option<{ credentialId: string; pubkey: string }> = Option.none();
  if (toolKeys[0]) {
    const credentialId = parseCredentialIdFromTitle(toolKeys[0].title);
    if (Option.isNone(credentialId))
      return yield* Effect.fail(`${GitSetupError.MissingCredentialIdError}: signing key title "${toolKeys[0].title}" has no credentialId`);
    maybeKey = Option.some({ credentialId: credentialId.value, pubkey: baseKey(toolKeys[0].key) });
  }

  // 5. Check authn keys too — must match signing key if both present.
  const authnKeys = yield* github.getAuthnKeys(token);
  const toolAuthnKeys = authnKeys.filter(k => k.title.startsWith(KEY_PREFIX));
  if (toolAuthnKeys.length > 1)
    return yield* Effect.fail(`${GitSetupError.MultipleJiveAuthnKeysError}: Found ${toolAuthnKeys.length} authn keys with "${KEY_PREFIX}" prefix — expected at most 1`);
  let maybeAuthnKey: Option.Option<{ credentialId: string; pubkey: string }> = Option.none();
  if (toolAuthnKeys[0]) {
    const credentialId = parseCredentialIdFromTitle(toolAuthnKeys[0].title);
    if (Option.isNone(credentialId))
      return yield* Effect.fail(`${GitSetupError.MissingCredentialIdError}: authn key title "${toolAuthnKeys[0].title}" has no credentialId`);
    maybeAuthnKey = Option.some({ credentialId: credentialId.value, pubkey: baseKey(toolAuthnKeys[0].key) });
  }
  if (Option.isSome(maybeKey) && Option.isSome(maybeAuthnKey) && maybeKey.value.pubkey !== maybeAuthnKey.value.pubkey)
    return yield* Effect.fail(`${GitSetupError.SigningAuthnKeyMismatchError}: signing key and authn key pubkeys don't match — GitHub account is in an inconsistent state`);

  // 6. Ensure agent is running
  yield* agentClient.ensureRunning();

  // 7. Call agent to get/create/verify key
  const { pubkey, credentialId } = yield* agentClient.usingClient(function* (client): EffectGen<{ pubkey: string; credentialId: string }, string> {
    return yield* pipe(
      client.Setup({
        pubkey: Option.map(maybeKey, k => k.pubkey),
        credentialId: Option.map(maybeKey, k => k.credentialId),
        username: ghUser.login,
      }),
      Effect.mapError(e => `${GitSetupError.AgentProcedureFailedError}: ${String(e)}`)
    );
  });
  const credentialFriendlyName = new CredentialId(credentialId).humanReadableName;
  const keyTitle = `${credentialFriendlyName} (${credentialId})`;

  // 8. Register signing key on GitHub if not already present
  if (Option.isNone(maybeKey)) {
    yield* github.addSigningKey(token, keyTitle, pubkey);
    log(`✓ Registered GitHub signing key: ${keyTitle}`);
  }

  // 9. Register key as authn key on GitHub account if not already present
  if (Option.isNone(maybeAuthnKey)) {
    yield* github.addAuthnKey(token, keyTitle, pubkey);
    log(`✓ Registered authn key on GitHub account`);
  }

  // 10. Write ssh config (pubkey file written by agent via KeyMapStore.addKey)
  const pubkeyPath = sshConfig.getPubkeyPath(credentialFriendlyName);
  yield* sshConfig.writeHost({
    section: {
      HostName: "github.com",
      User: "git",
      IdentityFile: pubkeyPath,
      IdentitiesOnly: "yes",
      IdentityAgent: AGENT_SOCK_FILE_PATH,
    },
  });

  // 11. Clone if in clone mode
  if (isCloneMode) {
    yield* git.clone(owner, repo);
    log(`✓ Cloned into ${repo}/`);
  }

  // 12. Set local git config
  const gitConfigs: [string, string][] = [
    ['remote.origin.url', `git@github.com:${owner}/${repo}.git`],
    ['user.name', ghUser.login],
    ['user.email', ghUser.email],
    ['user.signingkey', pubkeyPath],
    ['gpg.format', 'ssh'],
    ['gpg.ssh.program', SSH_KEYGEN_CMD_PATH],
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
  Layer.provideMerge(SSHConfigImpl.Layer),
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
