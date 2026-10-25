import { type EffectGen} from "effective-modules";
import { Option } from "effect";

export interface GitUser {
  name: string;
  email: string;
}

export type RemoteProtocol = "http" | "ssh";

export interface Remote {
  owner: string;
  repo: string;
  formatted: string;
  raw: string;
  protocol: RemoteProtocol;
}

export interface SetupRepoInput {
  dir: string;
  user: GitUser;
  pubkeyPath: string;
  remoteURL: string;
}

export interface IGit {
  isGitRepository(): EffectGen<boolean>;
  /** Reads and parses remote.origin.url when configured; invalid remotes fail with a parse error. */
  getRemoteOrigin(): EffectGen<Option.Option<Remote>, string>;
  /**
   * 
   * @param maybeOwnerAndRepo possible passed owner/repo string if None is passed, tries to derive from reading current directory
   */
  resolveOwnerAndRepo(maybeOwnerAndRepo: Option.Option<string>): EffectGen<Remote, string>;
  init(): EffectGen<void, string>;
  /**
   * Clones repo into subdirectory of current directory with name repo
   * Then changes directory into this new directory
   * @param remote 
   */
  clone(remote: Remote): EffectGen<void, string>;
  setLocalConfig(key: string, value: string): EffectGen<void, string>;
  setupRepo(params: SetupRepoInput): EffectGen<void, string>;
}
