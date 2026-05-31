import { Data, Deferred } from "effect";
import type { EffectGen } from "effective-modules";
import type { CredentialId } from "../crypto/impl";
import type { SSHKey } from "../crypto/interface";

export type SessionError = Data.TaggedEnum<{
  WebAuthnCancelled: {};
  SetupMustBeStandalone: {};
  MultipleUsers: {
    byUserId: Record<string, {user: User; repos: Repo[];}>;
  };
  MultipleCredentials: {
    byCredentialId: Record<string, {user: User; repo: Repo}[]>
  };
  InternalError: {
    reason: string;
  };
  DisruptingActiveSession: {};
  UserNotSetup: {
    user: User;
  };
  RepoNotSetup: {
    repo: Repo;
  }
}>;

export const SessionError = Data.taggedEnum<SessionError>();

export type Repo = {
  owner: string;
  name: string;
  id: string;
}

export type Action = Data.TaggedEnum<{
  Commit: {
    user: User;
    repo: Repo;
    message: string;
    signingKey: string;
  };
  Push: {
    user: User;
    repo: Repo;
    deployKey: string;
  };
  Pull: {
    user: User;
    repo: Repo;
    deployKey: string;
  };
  Clone: {
    user: User;
    repo: Repo;
    to: string;
    deployKey: string;
  };
  Setup: {
    user: User;
    repos: Repo[];
  }
}>;

export const Action = Data.taggedEnum<Action>();

export interface User {
  name: string;
  email: string;
  id: string;
}

export interface ExistingKey {
  credentialId: string;
  pubkey: string;
}

export interface DerivedKeys {
  credentialId: CredentialId;
  signingKey: SSHKey;
  // Map from repoId to deploy key-pair.
  deployKeys: Record<string, SSHKey>;
}

export interface ActiveSession {
  awaitingActions: Action[];
  receivedActions: {
    action: Action;
    deferred: Deferred.Deferred<DerivedKeys, SessionError>;
  }[];
}

export interface ISession {
  //getOrSetupKeys(user: User, repos: Repo[], credentialId?: string): EffectGen<GetOrSetupKeysResult, SessionError>;
  startSession(input: { actions: Action[]; }): EffectGen<ActiveSession, SessionError>;
  ingestAction(action: Action): EffectGen<DerivedKeys, SessionError>;
  //sign(input: { dataToSign: Buffer; action: Action; }): EffectGen<Buffer, SessionError>;
}
