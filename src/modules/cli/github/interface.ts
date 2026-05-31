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

export interface GitHubAuthnKey {
  readonly id: number;
  readonly title: string;
  readonly key: string;
}

export interface IGitHub {
  authorize(clientId: string, clientSecret: string, scopes: string): EffectGen<string, string>;
  getUser(token: string): EffectGen<GitHubUser, string>;
  getSigningKeys(token: string): EffectGen<GitHubSshSigningKey[], string>;
  addSigningKey(token: string, title: string, key: string): EffectGen<void, string>;
  getAuthnKeys(token: string): EffectGen<readonly GitHubAuthnKey[], string>;
  addAuthnKey(token: string, title: string, key: string): EffectGen<void, string>;
}
