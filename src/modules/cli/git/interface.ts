import { type EffectGen} from "effective-modules";
import { Option } from "effect";

export interface GitUser {
  name: string;
  email: string;
}

export interface SetupRepoInput {
  dir: string;
  user: GitUser;
  pubkeyPath: string;
  remoteURL: string;
}

export interface IGit {
  isGitRepository(): EffectGen<boolean>;
  getRemoteOrigin(): EffectGen<Option.Option<string>>;
  resolveOwnerAndRepo(maybeOwnerAndRepo: Option.Option<string>): EffectGen<{owner: string; repo: string;}, string>;
  clone(owner: string, repo: string): EffectGen<void, string>;
  setLocalConfig(key: string, value: string): EffectGen<void, string>;
  setupRepo(params: SetupRepoInput): EffectGen<void, string>;
}