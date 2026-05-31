import { Deferred, Effect, Option, pipe, Equal, Result, Schema, FileSystem } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { agentModules } from "../agent-modules";
import { commonModules } from "../common-modules";
import { log } from "../../common/log";
import { AGENT_KEY_MAP_PATH } from "../../common/constants";
import { SessionError, Action, type ISession, type DerivedKeys, type Repo, type User, type ActiveSession } from "./interface";
import { prfFlow } from "./prf-flow";
import { CredentialId } from "../crypto/impl";

const KeyMapSchema = Schema.Struct({
  // User id to signing key and repo keys
  userKeys: Schema.Record(Schema.String, Schema.Struct({
    signingKey: Schema.String,
    // repo id to deploy keys
    deployKeys: Schema.Record(Schema.String, Schema.String)
  })),
  pubKeysToCredentialIds: Schema.Record(Schema.String, Schema.String)
});

export type DeepMutable<T> = {
  -readonly [P in keyof T]: DeepMutable<T[P]>;
};

export class SessionImpl extends implementing(agentModules.Session).uses(commonModules.OSPlatform, agentModules.Crypto, FileSystem.FileSystem) implements ISession {
  // Only allow one active session to prevent malicious actors from sending in requests
  // TODO: is it reasonable to only anticipate one at a time?
  //       it definitely enhances security.
  private activeSession: Option.Option<ActiveSession> = Option.none();

  private get fs() {
    return this.getDependency(FileSystem.FileSystem);
  }

  private *readKeyMap(): EffectGen<DeepMutable<Schema.Schema.Type<typeof KeyMapSchema>>, SessionError> {
    const exists = yield* pipe(
      this.fs.exists(AGENT_KEY_MAP_PATH),
      Effect.catchTag("PlatformError", err => Effect.fail(SessionError.InternalError({
        reason: err.message
      })))
    );
    if (!exists) {
      return {
        userKeys: {},
        pubKeysToCredentialIds: {}
      };
    }
    const contents = yield* pipe(
      this.fs.readFileString(AGENT_KEY_MAP_PATH),
      Effect.catchTag("PlatformError", err => Effect.fail(SessionError.InternalError({
        reason: err.message
      })))
    );
    return yield* pipe(
      contents,
      Schema.decodeEffect(Schema.fromJsonString(KeyMapSchema)),
      Effect.catchTag("SchemaError", err => Effect.fail(SessionError.InternalError({
        reason: `${AGENT_KEY_MAP_PATH} is malformed. ${err.message}`
      })))
    );
  }

  private *writeKeyMap(user: User, derivedKeys: DerivedKeys): EffectGen<void, SessionError> {
    const current = yield* effunct(this.readKeyMap)();
    const existingUser = current.userKeys[user.id];
    current.userKeys[user.id] = {
      signingKey: derivedKeys.signingKey.sshPublicKey,
      deployKeys: {}
    }
    if (existingUser) {
      // We need to go through all existing keys and possibly prune them.
      if (existingUser.signingKey !== derivedKeys.signingKey.sshPublicKey) {
        delete current.pubKeysToCredentialIds[existingUser.signingKey];
      }
      for (const repoId in existingUser.deployKeys) {
        const curDeployKey = existingUser.deployKeys[repoId]!;
        if (current.pubKeysToCredentialIds[curDeployKey] !== derivedKeys.credentialId.base58) {
          delete current.pubKeysToCredentialIds[curDeployKey];
          delete existingUser.deployKeys[repoId];
        } else {
          current.userKeys[user.id].deployKeys[repoId] = curDeployKey;
        }
      }
    }
    for (const repoId in derivedKeys.deployKeys) {
      const curDeployKey = derivedKeys.deployKeys[repoId]!.sshPublicKey;
      current.userKeys[user.id].deployKeys[repoId] = curDeployKey;
      current.pubKeysToCredentialIds[curDeployKey] = derivedKeys.credentialId.base58;
    }
    yield* pipe(
      this.fs.writeFileString(AGENT_CREDENTIAL_MAP_PATH, JSON.stringify(current, null, 2)),
      Effect.catchTag("PlatformError", err => Effect.fail(SessionError.InternalError({
        reason: err.message
      })))
    );
  }

  private getCredentialByPubKey(pubkey: string): Option.Option<string> {
    const keyMap = Effect.runSync(pipe(
      effunct(this.readKeyMap)(),
      Effect.tapError(Effect.fn(function*(err) {
        log(err);
      })),
      Effect.option,
    ));
    return pipe(
      keyMap,
      Option.flatMapNullishOr(map => map.pubKeysToCredentialIds[pubkey])
    );
  }

  private getSigningPubKeyByUser(user: User): Option.Option<string> {
    const keyMap = Effect.runSync(pipe(
      effunct(this.readKeyMap)(),
      Effect.tapError(Effect.fn(function*(err) {
        log(err);
      })),
      Effect.option,
    ));
    return pipe(
      keyMap,
      Option.flatMapNullishOr(map => map.userKeys[user.id]),
      Option.map(userKeys => userKeys.signingKey)
    );
  }

  *ingestAction(action: Action): EffectGen<DerivedKeys, SessionError> {
    const session: ActiveSession = 
      Option.isSome(this.activeSession) ?
        this.activeSession.value :
      yield* this.startSession({actions: [action]});
    if (session.awaitingActions.length === 0) {
      return yield* Effect.fail(SessionError.DisruptingActiveSession());
    }
    const result = yield* Deferred.make<DerivedKeys, SessionError>();
    let foundMatchingAction = false;
    for (let i = 0; i < session.awaitingActions.length; ++i) {
      const curAction: Action = session.awaitingActions[i];
      if (Equal.equals(action, curAction)) {
        session.awaitingActions.slice(i, i + 1);
        --i;
        session.receivedActions.push({
          action,
          deferred: result
        });
        foundMatchingAction = true;
        break;
      }
    }
    if (!foundMatchingAction) {
      return yield* Effect.fail(SessionError.DisruptingActiveSession());
    }
    if (session.awaitingActions.length === 0) {
      // All actions have been gathered. Now time to get the keys and return them to each action
      const firstAction = session.receivedActions[0]!.action;
      const existingCredential: Option.Option<CredentialId> = firstAction._tag === "Setup" ?
        pipe(
          this.getSigningPubKeyByUser(firstAction.user),
          Option.flatMap(this.getCredentialByPubKey),
          Option.map(credentialId => new CredentialId(credentialId))
        ) :
        Option.none();
      const actions: Action[] = session.receivedActions.map(({action}) => action);
      const prfResult = yield* pipe(
        effunct(prfFlow)(actions, existingCredential, firstAction.user),
        Effect.scoped,
        Effect.provide(this.context),
        Effect.result
      );
      if (Result.isSuccess(prfResult)) {
        yield* this.writeKeyMap(firstAction.user, prfResult.success);
      }
      for (const {action, deferred} of session.receivedActions) {
        let acceptedResult = false;
        if (Result.isSuccess(prfResult)) {
          acceptedResult = yield* Deferred.succeed(deferred, prfResult.success);
        } else {
          acceptedResult = yield* Deferred.fail(deferred, prfResult.failure);
        }
        if (!acceptedResult) {
          return yield* Effect.fail(SessionError.InternalError({
            reason: `Replied to action ${JSON.stringify(action)} multiple times`
          }));
        }
      }
    }
    return yield* Deferred.await(result);
  }

  *startSession({actions}: { actions: Action[]; }): EffectGen<ActiveSession, SessionError> {
    if (Option.isSome(this.activeSession)) {
      return yield* Effect.fail(SessionError.DisruptingActiveSession());
    }
    const users: Record<string, {user: User; repos: Repo[];}> = {};
    const credentials: Record<string, {user: User; repo: Repo}[]> = {};
    const record = (user: User, repo: Repo, key: string) => {
      const maybeCredential = this.getCredentialByPubKey(key);
      if (Option.isNone(maybeCredential))
        return Effect.fail(SessionError.RepoNotSetup({repo}));
      if (!(user.id in users)) {
        users[user.id] = {user, repos: []};
      }
      users[user.id]!.repos.push(repo);
      const credential = maybeCredential.value;
      if (!(credential in credentials)) {
        credentials[credential] = [];
      }
      credentials[credential]!.push({user, repo});
      return Effect.succeed<void>(undefined);
    }
    for (const action of actions) {
      yield* Action.$match({
        Clone: ({user, repo, deployKey}) => {
          return record(user, repo, deployKey);
        },
        Commit: ({user, repo, signingKey}) => {
          return record(user, repo, signingKey);
        },
        Pull: ({user, repo, deployKey}) => {
          return record(user, repo, deployKey);
        },
        Push: ({user, repo, deployKey}) => {
          return record(user, repo, deployKey);
        },
        Setup: () => {
          if (actions.length > 1)
            return Effect.fail(SessionError.SetupMustBeStandalone());
          return Effect.succeed<void>(undefined);
        }
      })(action);
    }
    if (Object.keys(users).length > 1) {
      return yield* Effect.fail(SessionError.MultipleUsers({ byUserId: users }));
    }
    if (Object.keys(credentials).length > 1) {
      return yield* Effect.fail(SessionError.MultipleCredentials({ byCredentialId: credentials }));
    }
    const session: ActiveSession = {
      awaitingActions: [...actions],
      receivedActions: []
    };
    this.activeSession = Option.some(session);
    return session;
  }

  /*
  *sign({ pubkeyWire, dataToSign }: { pubkeyWire: Buffer; dataToSign: Buffer; context: SessionContext }): EffectGen<Buffer, SessionError> {
    const pubkeyStr = `ssh-ed25519 ${pubkeyWire.toString('base64')}`;
    const session = this.activeSessions.get(pubkeyStr);

    if (session) {
      this.activeSessions.delete(pubkeyStr);
      return yield* Effect.sync(() => {
        try {
          const signature = cryptoSign(null, dataToSign, createPrivateKey(session.privkey));
          const sigBlob = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(signature)]);
          const body = Buffer.concat([Buffer.from([SSH2_AGENT_SIGN_RESPONSE]), sshString(sigBlob)]);
          return Buffer.concat([u32(body.length), body]);
        } catch {
          return failureBuffer();
        }
      });
    }

    // TODO: parse context from dataToSign to determine credentialId for on-the-fly PRF flow
    return yield* Effect.sync(() => failureBuffer());
  }
    */
}
