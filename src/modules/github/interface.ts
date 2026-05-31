import type { EffectGen } from "effective-modules";

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

export interface GitHubDeployKey {
  readonly id: number;
  readonly title: string;
  readonly key: string;
}

export interface IGitHub {
  authorize(clientId: string, clientSecret: string, scopes: string): EffectGen<string, string>;
  getUser(token: string): EffectGen<GitHubUser, string>;
  checkRepoAccess(token: string, owner: string, repo: string): EffectGen<{id: string}, string>;
  getSigningKeys(token: string): EffectGen<GitHubSshSigningKey[], string>;
  addSigningKey(token: string, title: string, key: string): EffectGen<void, string>;
  listDeployKeys(token: string, owner: string, repo: string): EffectGen<readonly GitHubDeployKey[], string>;
  addDeployKey(token: string, owner: string, repo: string, title: string, key: string): EffectGen<void, string>;
}
