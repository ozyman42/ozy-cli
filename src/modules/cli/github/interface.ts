import type { EffectGen } from "effective-modules";
import type { Option } from "effect";
import type { GitUser, Remote, RemoteProtocol } from "../git/interface";

export interface GitHubUser {
  login: string;
  name: string;
  email: string;
  id: number;
}

export interface GitHubSshSigningKey {
  id: number;
  title: string;
  key: string;
}

export interface GitHubAuthnKey {
  readonly id: number;
  readonly title: string;
  readonly key: string;
}

export interface GitHubRepoAccess {
  readonly owner: string;
  readonly repo: string;
  readonly canPush: boolean;
}

export interface IGitHub {
  /** Constructs the canonical github.com Remote for owner/repo in the given protocol. */
  getRemote(owner: string, repo: string, protocol: RemoteProtocol): Remote;
  authorize(clientId: string, clientSecret: string, scopes: string): EffectGen<string, string>;
  getUser(token: string): EffectGen<GitHubUser, string>;
  /** Returns repository access when the repo exists; missing repos are represented as none. */
  getRepoAccess(token: string, remote: Remote): EffectGen<Option.Option<GitHubRepoAccess>, string>;
  /** Checks whether the authenticated user can create a new repo under owner (their own login, or an org they can create repos in). */
  canCreateRepo(token: string, owner: string): EffectGen<boolean, string>;
  /** Creates a new repo under remote.owner (the caller's own login, or an org) — call canCreateRepo first to confirm permission. */
  createRepo(session: { token: string; login: string }, remote: Remote): EffectGen<void, string>;
  getSigningKeys(token: string): EffectGen<GitHubSshSigningKey[], string>;
  addSigningKey(token: string, title: string, key: string): EffectGen<void, string>;
  getAuthnKeys(token: string): EffectGen<readonly GitHubAuthnKey[], string>;
  addAuthnKey(token: string, title: string, key: string): EffectGen<void, string>;
  /**
   * Full "verified commits" sign-in: OAuth's with jive's own GitHub OAuth app, requesting signing/authn
   * key write scopes plus any extraScopes the caller also needs granted in the same consent (e.g. "repo"
   * for callers that also need repo read/write access — pass Option.none() to skip). Reconciles any
   * existing jive-managed signing/authn key against the local signing agent (creating one if absent),
   * registers it on GitHub if missing, and writes the SSH config host entry that routes github.com SSH
   * traffic through the agent. Returns the token and login for other GitHub API calls, the derived git
   * commit identity, and the pubkey path that git config needs to configure a repo for commit signing.
   */
  signIn(extraScopes: Option.Option<string>): EffectGen<{ token: string; login: string; user: GitUser; pubkeyPath: string }, string>;
}
