import { Deferred, Effect, Schema } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "../cli-modules";
import { commonModules } from "../common-modules";
import { log } from "../../common/log";
import type { IGitHub, GitHubUser, GitHubSshSigningKey, GitHubDeployKey } from "./interface";

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

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

const GitHubDeployKeySchema = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  key: Schema.String,
});

const GitHubRepoSchema = Schema.Struct({
  id: Schema.Int,
});

export class GitHubImpl extends implementing(modules.GitHub).uses(commonModules.OSPlatform) implements IGitHub {
  private api<A>(token: string, method: string, path: string, schema: Schema.Schema<A>, body?: unknown, debug?: boolean): Effect.Effect<{ status: number; data: A }, string> {
    return Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${API_BASE}${path}`, {
          method,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const rawData = await res.json();
        if (debug) log(`[debug] ${method} ${path} (${res.status}):\n${JSON.stringify(rawData, null, 2)}`);
        return { status: res.status, rawData };
      },
      catch: (e) => `GitHub API request failed: ${e instanceof Error ? e.message : String(e)}`,
    }).pipe(
      Effect.flatMap(({ status, rawData }) =>
        (Schema.decodeUnknownEffect(schema)(rawData) as Effect.Effect<A, unknown, never>).pipe(
          Effect.map(data => ({ status, data })),
          Effect.mapError(parseError =>
            status < 200 || status >= 300
              ? `${method} ${path} returned HTTP ${status}`
              : `Failed to parse ${method} ${path} response: ${String(parseError)}`
          )
        )
      )
    );
  }

  *authorize(clientId: string, clientSecret: string, scopes: string): EffectGen<string, string> {
    const osPlatform = this.dependencies.OSPlatform;
    return yield* Effect.scoped(Effect.gen(function* () {
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

      const tokenRes = yield* Effect.tryPromise({
        try: () => fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        }),
        catch: () => 'Token exchange request failed',
      });

      const tokenData = yield* Effect.tryPromise({
        try: () => tokenRes.json() as Promise<{ access_token?: string; error?: string; error_description?: string }>,
        catch: () => 'Failed to parse token exchange response',
      });

      if (!tokenData.access_token)
        return yield* Effect.fail(tokenData.error_description ?? tokenData.error ?? 'Token exchange failed');

      return tokenData.access_token;
    }));
  }

  *getUser(token: string): EffectGen<GitHubUser, string> {
    const { data: { login, name, id } } = yield* this.api(token, 'GET', '/user', GitHubUserSchema);
    const { data: emails } = yield* this.api(token, 'GET', '/user/emails', Schema.Array(GitHubEmailSchema));
    const primaryEmail = emails.find(e => e.primary);
    if (!primaryEmail)
      return yield* Effect.fail(`No primary email found on GitHub account — add one at github.com/settings/emails`);
    return { login, name, email: primaryEmail.email, id };
  }

  *checkRepoAccess(token: string, owner: string, repo: string): EffectGen<{id: string}, string> {
    const { data: { id } } = yield* this.api(token, 'GET', `/repos/${owner}/${repo}`, GitHubRepoSchema);
    return { id: id.toString() };
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

  *listDeployKeys(token: string, owner: string, repo: string): EffectGen<readonly GitHubDeployKey[], string> {
    const { data } = yield* this.api(token, 'GET', `/repos/${owner}/${repo}/keys`, Schema.Array(GitHubDeployKeySchema));
    return data;
  }

  *addDeployKey(token: string, owner: string, repo: string, title: string, key: string): EffectGen<void, string> {
    const { status } = yield* this.api(token, 'POST', `/repos/${owner}/${repo}/keys`, Schema.Unknown, { title, key, read_only: false });
    if (status !== 201)
      yield* Effect.fail(`POST /repos/${owner}/${repo}/keys returned HTTP ${status}`);
  }
}
