import { Deferred, Effect, Option, Schema, pipe, Match } from "effect";
import { HttpBody, HttpClient, HttpClientRequest, HttpMethod } from "effect/http";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { cliModules } from "@/modules/cli";
import { commonModules } from "@/modules/common";
import { log } from "@/common/log";
import { type IGitHub, type GitHubUser, type GitHubSshSigningKey, type GitHubAuthnKey, type GitHubRepoAccess } from "./interface";
import type { GitUser, Remote, RemoteProtocol } from "../git/interface";
import type { AgentClientError } from "../agent-client/interface";
import { AGENT_SOCK_FILE_PATH, FUTURE_TOOL_NAME, JIVE_GITHUB_CLIENT_ID, JIVE_GITHUB_CLIENT_SECRET, STANDARD_REMOTE_HOST, STANDARD_REMOTE_PREFIX } from "@/common/constants";
import { CredentialId } from "@/modules/common/crypto/impl";

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

const KEY_PREFIX = `${FUTURE_TOOL_NAME}-`;

type AgentKey = { readonly pubkey: string; readonly credentialId: string };

enum SignInError {
  MultipleJiveSigningKeysError = 'MultipleJiveSigningKeysError',
  MultipleJiveAuthnKeysError = 'MultipleJiveAuthnKeysError',
  MissingCredentialIdError = 'MissingCredentialIdError',
  SigningAuthnKeyMismatchError = 'SigningAuthnKeyMismatchError',
  AgentProcedureFailedError = 'AgentProcedureFailedError',
}

function parseCredentialIdFromTitle(title: string): Option.Option<string> {
  const match = title.match(/\(([^)]+)\)$/);
  if (!match) return Option.none();
  return Option.some(match[1]!);
}

function baseKey(pubkey: string): string {
  return pubkey.split(' ').slice(0, 2).join(' ');
}

const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Authorization successful</title></head>
<body><h1>Authorization successful</h1>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;

const GitHubUserSchema = Schema.Struct({
  login: Schema.String,
  name: Schema.String,
  id: Schema.Int
});

const GitHubEmailSchema = Schema.Struct({
  email: Schema.String,
  primary: Schema.Boolean,
  verified: Schema.Boolean,
});

const GitHubSshSigningKeySchema = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  key: Schema.String,
});

const GitHubAuthnKeySchema = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  key: Schema.String,
});

const GitHubRepoAccessSchema = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({
    login: Schema.String,
  }),
  permissions: Schema.optional(Schema.Struct({
    push: Schema.optional(Schema.Boolean),
  })),
});

const OrgMembershipSchema = Schema.Struct({
  role: Schema.Literals(["admin", "member"]),
});

const OrgSchema = Schema.Struct({
  members_can_create_repositories: Schema.optional(Schema.Boolean),
});

export class GitHubImpl extends implementing(cliModules.GitHub).uses(commonModules.OSPlatform, commonModules.SSHConfig, cliModules.AgentClient, HttpClient.HttpClient) implements IGitHub {
  getRemote(owner: string, repo: string, type: RemoteProtocol): Remote {
    const raw = pipe(
      type,
      pipe(
        Match.type<RemoteProtocol>(),
        Match.when("http", () => `https://${STANDARD_REMOTE_HOST}/${owner}/${repo}.git`),
        Match.when("ssh", () => `${STANDARD_REMOTE_PREFIX}${owner}/${repo}.git`),
        Match.exhaustive,
      )
    )
    return {
      owner,
      repo,
      formatted: `${owner}/${repo}`,
      raw,
      protocol: type
    }
  }
  private apiRaw(token: string, method: HttpMethod.HttpMethod, path: string, body?: unknown, debug?: boolean): Effect.Effect<{ status: number; rawData: unknown }, string> {
    const client = this.getDependency(HttpClient.HttpClient);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
    const requestOptions = body
      ? { headers, body: HttpBody.text(JSON.stringify(body), 'application/json') }
      : { headers };
    return pipe(
      client.execute(HttpClientRequest.make(method)(`${API_BASE}${path}`, requestOptions)),
      Effect.mapError(e => `GitHub API request failed: ${String(e)}`),
      Effect.flatMap(response => pipe(
        response.json,
        Effect.mapError(e => `GitHub API request failed: ${String(e)}`),
        Effect.map(rawData => {
          if (debug) log(`[debug] ${method} ${path} (${response.status}):\n${JSON.stringify(rawData, null, 2)}`);
          return { status: response.status, rawData };
        }),
      )),
    );
  }

  private api<A>(token: string, method: HttpMethod.HttpMethod, path: string, schema: Schema.Schema<A>, body?: unknown, debug?: boolean): Effect.Effect<{ status: number; data: A }, string> {
    return this.apiRaw(token, method, path, body, debug).pipe(
      Effect.flatMap(({ status, rawData }) => this.decodeApiResponse(method, path, status, rawData, schema))
    );
  }

  private decodeApiResponse<A>(method: string, path: string, status: number, rawData: unknown, schema: Schema.Schema<A>): Effect.Effect<{ status: number; data: A }, string> {
    return (Schema.decodeUnknownEffect(schema)(rawData) as Effect.Effect<A, unknown, never>).pipe(
      Effect.map(data => ({ status, data })),
      Effect.mapError(parseError =>
        status < 200 || status >= 300
          ? `${method} ${path} returned HTTP ${status}`
          : `Failed to parse ${method} ${path} response: ${String(parseError)}`
      )
    );
  }

  private repoAccessFromData(data: Schema.Schema.Type<typeof GitHubRepoAccessSchema>): GitHubRepoAccess {
    return {
      owner: data.owner.login,
      repo: data.name,
      canPush: data.permissions?.push === true,
    };
  }

  *authorize(clientId: string, clientSecret: string, scopes: string): EffectGen<string, string> {
    const osPlatform = this.dependencies.OSPlatform;
    const client = this.getDependency(HttpClient.HttpClient);
    function* oauthFlow() {
      const state = crypto.randomUUID();
      const deferred = yield* Deferred.make<string, string>();

      const server = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.serve({
          port: 0,
          async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === '/callback') {
              const code = url.searchParams.get('code');
              const returnedState = url.searchParams.get('state');
              if (returnedState !== state) {
                Effect.runFork(Deferred.fail(deferred, 'State mismatch — possible CSRF attack'));
                return new Response('State mismatch', { status: 400 });
              }
              if (!code) {
                Effect.runFork(Deferred.fail(deferred, 'Missing authorization code in callback'));
                return new Response('Missing code', { status: 400 });
              }
              Effect.runFork(Deferred.succeed(deferred, code));
              return new Response(OAUTH_SUCCESS_HTML, { headers: { 'Content-Type': 'text/html' } });
            }
            return new Response('Not found', { status: 404 });
          },
        })),
        (server) => Effect.sync(() => server.stop()),
      );

      const redirectUri = `http://localhost:${server.port}/callback`;
      const authUrl = new URL('https://github.com/login/oauth/authorize');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('scope', scopes);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('prompt', 'select_account');

      log('Opening browser for GitHub authorization...');
      yield* osPlatform.openBrowserWindow(authUrl.toString());

      const code = yield* Deferred.await(deferred);

      const tokenResponse = yield* pipe(
        client.post('https://github.com/login/oauth/access_token', {
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: HttpBody.text(
            JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
            'application/json',
          ),
        }),
        Effect.mapError(() => 'Token exchange request failed'),
      );

      const tokenData = (yield* pipe(
        tokenResponse.json,
        Effect.mapError(() => 'Failed to parse token exchange response'),
      )) as { access_token?: string; error?: string; error_description?: string };

      if (!tokenData.access_token)
        return yield* Effect.fail(tokenData.error_description ?? tokenData.error ?? 'Token exchange failed');

      return tokenData.access_token;
    }
    return yield* Effect.scoped(effunct(oauthFlow)());
  }

  *getUser(token: string): EffectGen<GitHubUser, string> {
    const { data: { login, name, id } } = yield* this.api(token, 'GET', '/user', GitHubUserSchema);
    const { data: emails } = yield* this.api(token, 'GET', '/user/emails', Schema.Array(GitHubEmailSchema));
    const primaryEmail = emails.find(e => e.primary);
    if (!primaryEmail)
      return yield* Effect.fail(`No primary email found on GitHub account — add one at github.com/settings/emails`);
    return { login, name, email: primaryEmail.email, id };
  }

  *getRepoAccess(token: string, remote: Remote): EffectGen<Option.Option<GitHubRepoAccess>, string> {
    const path = `/repos/${remote.owner}/${remote.repo}`;
    const { status, rawData } = yield* this.apiRaw(token, 'GET', path);
    if (status === 404) return Option.none();
    const { data } = yield* this.decodeApiResponse('GET', path, status, rawData, GitHubRepoAccessSchema);
    return Option.some(this.repoAccessFromData(data));
  }

  *canCreateRepo(token: string, owner: string): EffectGen<boolean, string> {
    const { data: { login } } = yield* this.api(token, 'GET', '/user', GitHubUserSchema);
    if (login.toLowerCase() === owner.toLowerCase()) return true;

    const membershipPath = `/user/memberships/orgs/${owner}`;
    const { status, rawData } = yield* this.apiRaw(token, 'GET', membershipPath);
    if (status === 404) return false;
    const { data: membership } = yield* this.decodeApiResponse('GET', membershipPath, status, rawData, OrgMembershipSchema);
    if (membership.role === 'admin') return true;

    const { data: org } = yield* this.api(token, 'GET', `/orgs/${owner}`, OrgSchema);
    return org.members_can_create_repositories === true;
  }

  *createRepo(session: { token: string; login: string }, remote: Remote): EffectGen<void, string> {
    const path = session.login.toLowerCase() === remote.owner.toLowerCase()
      ? '/user/repos'
      : `/orgs/${remote.owner}/repos`;
    const { status } = yield* this.apiRaw(session.token, 'POST', path, { name: remote.repo });
    if (status !== 201) {
      return yield* Effect.fail(`failed to create ${remote.formatted} on GitHub (HTTP ${status})`);
    }
  }

  *getSigningKeys(token: string): EffectGen<GitHubSshSigningKey[], string> {
    const { data } = yield* this.api(token, 'GET', '/user/ssh_signing_keys', Schema.Array(GitHubSshSigningKeySchema));
    return data as GitHubSshSigningKey[];
  }

  *addSigningKey(token: string, title: string, key: string): EffectGen<void, string> {
    const { status } = yield* this.api(token, 'POST', '/user/ssh_signing_keys', Schema.Unknown, { title, key });
    if (status !== 201)
      yield* Effect.fail(`POST /user/ssh_signing_keys returned HTTP ${status}`);
  }

  *getAuthnKeys(token: string): EffectGen<readonly GitHubAuthnKey[], string> {
    const { data } = yield* this.api(token, 'GET', `/user/keys`, Schema.Array(GitHubAuthnKeySchema));
    return data;
  }

  *addAuthnKey(token: string, title: string, key: string): EffectGen<void, string> {
    const { status } = yield* this.api(token, 'POST', `/user/keys`, Schema.Unknown, { title, key });
    if (status !== 201)
      yield* Effect.fail(`POST /user/keys returned HTTP ${status}`);
  }

  *signIn(extraScopes: Option.Option<string>): EffectGen<{ token: string; login: string; user: GitUser; pubkeyPath: string }, string> {
    const sshConfig = this.dependencies.SSHConfig;

    const baseScopes = 'read:user user:email write:ssh_signing_key write:public_key';
    const scopes = Option.match(extraScopes, {
      onNone: () => baseScopes,
      onSome: extra => `${baseScopes} ${extra}`,
    });
    const token = yield* this.authorize(JIVE_GITHUB_CLIENT_ID, JIVE_GITHUB_CLIENT_SECRET, scopes);
    log('✓ Authorized with GitHub');

    const { login, email } = yield* this.getUser(token);
    const gitUser: GitUser = { name: login, email };
    log(`  Logged in as: ${gitUser.name} <${gitUser.email}>`);

    const signingKeys = yield* this.getSigningKeys(token);
    const toolKeys = signingKeys.filter(k => k.title.startsWith(KEY_PREFIX));
    if (toolKeys.length > 1)
      return yield* Effect.fail(`${SignInError.MultipleJiveSigningKeysError}: Found ${toolKeys.length} signing keys with "${KEY_PREFIX}" prefix — expected at most 1`);
    let maybeKey: Option.Option<AgentKey> = Option.none();
    if (toolKeys[0]) {
      const credentialId = parseCredentialIdFromTitle(toolKeys[0].title);
      if (Option.isNone(credentialId))
        return yield* Effect.fail(`${SignInError.MissingCredentialIdError}: signing key title "${toolKeys[0].title}" has no credentialId`);
      maybeKey = Option.some({ credentialId: credentialId.value, pubkey: baseKey(toolKeys[0].key) });
    }

    const authnKeys = yield* this.getAuthnKeys(token);
    const toolAuthnKeys = authnKeys.filter(k => k.title.startsWith(KEY_PREFIX));
    if (toolAuthnKeys.length > 1)
      return yield* Effect.fail(`${SignInError.MultipleJiveAuthnKeysError}: Found ${toolAuthnKeys.length} authn keys with "${KEY_PREFIX}" prefix — expected at most 1`);
    let maybeAuthnKey: Option.Option<AgentKey> = Option.none();
    if (toolAuthnKeys[0]) {
      const credentialId = parseCredentialIdFromTitle(toolAuthnKeys[0].title);
      if (Option.isNone(credentialId))
        return yield* Effect.fail(`${SignInError.MissingCredentialIdError}: authn key title "${toolAuthnKeys[0].title}" has no credentialId`);
      maybeAuthnKey = Option.some({ credentialId: credentialId.value, pubkey: baseKey(toolAuthnKeys[0].key) });
    }
    if (Option.isSome(maybeKey) && Option.isSome(maybeAuthnKey) && maybeKey.value.pubkey !== maybeAuthnKey.value.pubkey)
      return yield* Effect.fail(`${SignInError.SigningAuthnKeyMismatchError}: signing key and authn key pubkeys don't match — GitHub account is in an inconsistent state`);

    const { credentialId, pubkey } = yield* this.requestAgentKey(login, maybeKey);
    const credentialFriendlyName = new CredentialId(credentialId).humanReadableName;
    const keyTitle = `${credentialFriendlyName} (${credentialId})`;

    if (Option.isNone(maybeKey)) {
      yield* this.addSigningKey(token, keyTitle, pubkey);
      log(`✓ Registered GitHub signing key: ${keyTitle}`);
    }
    if (Option.isNone(maybeAuthnKey)) {
      yield* this.addAuthnKey(token, keyTitle, pubkey);
      log(`✓ Registered authn key on GitHub account`);
    }

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

    return { token, login, user: gitUser, pubkeyPath };
  }

  private *requestAgentKey(login: string, maybeKey: Option.Option<AgentKey>): EffectGen<AgentKey, string> {
    const agentClient = this.dependencies.AgentClient;
    return yield* pipe(
      effunct(function* (): EffectGen<AgentKey, AgentClientError<string>> {
        return yield* agentClient.usingClient(function* (client): EffectGen<AgentKey, string> {
          return yield* pipe(
            client.Setup({
              pubkey: Option.map(maybeKey, k => k.pubkey),
              credentialId: Option.map(maybeKey, k => k.credentialId),
              username: login,
            }),
            Effect.mapError(e => `${SignInError.AgentProcedureFailedError}: ${String(e)}`)
          );
        });
      })(),
      Effect.catchTag("AgentClientError", err => Effect.fail(err.reason)),
      Effect.catchTag("AgentClientUsageError", err => Effect.fail(err.cause))
    );
  }
}
