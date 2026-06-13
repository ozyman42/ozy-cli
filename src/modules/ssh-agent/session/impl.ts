import { Deferred, Effect, Option, pipe, Result, Layer } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { SSHPubkey, CredentialId, SSHKeyPair } from "@/modules/common/crypto/impl";
import { renderCallerTree } from "@/common/render-caller-tree";
import { BunHttpServer } from "@effect/platform-bun";
import { randomUUID } from "node:crypto";
import { agentModules } from "@/modules/ssh-agent";
import { commonModules } from "@/modules/common";
import { SessionError, type ISession, type SetupInput, SetupOutput, StartSessionInput, type SignInput } from "./interface";
import { AgentRpcGroup } from "./interface-rpc";
import { prfFlow, PrfInput, type PrfResult } from "./prf-flow";
import { AGENT_PORT, CURRENT_VERSION, DEFAULT_SESSION_TIMEOUT_SECONDS } from "@/common/constants";
import { HttpRouter } from "effect/unstable/http";
import { RpcServer, RpcSerialization } from "effect/unstable/rpc";
import { using } from "@/common/effective-modules-extensions";

export interface ActiveSession {
  id: string;
  definition: StartSessionInput;
  // The indices match the expected sign requests which were received
  receivedSignRequests: {
    deferredResponse: Deferred.Deferred<Buffer, SessionError>;
    signRequest: SignInput;
  }[];
  totalReceived: number;
  pubkey: string;
  credentialId: string;
  completed: boolean;
}

const { OSPlatform, Crypto, KeyMapStore } = commonModules;
const { Session } = agentModules;

const SIGN_REQUESTS_COLLECTION_TIMEOUT_SECONDS = 3;

export class SessionImpl extends implementing(Session).uses(OSPlatform, Crypto, KeyMapStore) implements ISession {
  private activeSession: Option.Option<ActiveSession> = Option.none();
  private keyCache = new Map<string, SSHKeyPair>();

  private *abortSession(session: ActiveSession, onlyCheckRequestsAccumulated: boolean): EffectGen<void> {
    if (session.completed) return;
    let timeout = session.definition.timeoutSeconds;
    if (onlyCheckRequestsAccumulated) {
      const expected = session.definition.expectedSignRequests.length;
      const actual = session.receivedSignRequests.length;
      if (expected === actual) {
        yield* Effect.log(`All sign requests were received for session ${session.id} within ${SIGN_REQUESTS_COLLECTION_TIMEOUT_SECONDS} seconds`);
        return;
      } else {
        yield* Effect.log(`After ${SIGN_REQUESTS_COLLECTION_TIMEOUT_SECONDS} seconds only ${actual}/${expected} sign requests were received for session ${session.id}. Aborting`);
        timeout = SIGN_REQUESTS_COLLECTION_TIMEOUT_SECONDS;
      }
    } else {
      yield* Effect.log(`Aborting session ${session.id} after ${timeout} seconds`);
    }
    if (Option.isSome(this.activeSession) && this.activeSession.value.id === session.id) {
      this.activeSession = Option.none();
    }
    // Fail all the sign requests.
    const error = SessionError.cases.SessionTimedOut.make({
      seconds: timeout
    });
    session.completed = true;
    for (let i = 0; i < session.definition.expectedSignRequests.length; ++i) {
      const maybeReceived = Option.fromNullishOr(session.receivedSignRequests[i]);
      if (Option.isNone(maybeReceived)) continue;
      const { deferredResponse } = maybeReceived.value;
      yield* Deferred.fail(deferredResponse, error);
    }
  }

  *startSession({expectedCommonAncestorPID, expectedSignRequests, timeoutSeconds, pubkey}: StartSessionInput): EffectGen<void, SessionError> {
    if (Option.isSome(this.activeSession)) {
      const activeId = this.activeSession.value.id;
      yield* Effect.log(`Blocked attempt to start session while ongoing active session ${activeId}`);
      return yield* Effect.fail(SessionError.cases.InterruptingSession.make({ id: activeId }));
    }
    const maybeCredential = yield* pipe(
      effunct(this.dependencies.KeyMapStore.getCredentialByPubkey)(SSHPubkey.fromAuthorizedKey(pubkey)),
      Effect.catch(err => Effect.fail(SessionError.cases.InternalError.make({
        reason: `Failed to read from key map store: ${err}`
      })))
    )
    if (Option.isNone(maybeCredential)) {
      return yield* Effect.fail(SessionError.cases.PubkeyNotRegistered.make({
        pubkey
      }));
    }
    const id = randomUUID();
    const session: ActiveSession = {
      definition: {expectedCommonAncestorPID, expectedSignRequests, timeoutSeconds, pubkey},
      receivedSignRequests: [],
      id,
      totalReceived: 0,
      pubkey,
      credentialId: maybeCredential.value,
      completed: false
    };
    this.activeSession = Option.some(session);
    const n = expectedSignRequests.length;
    yield* Effect.log(`Starting session ${id} for ${new CredentialId(maybeCredential.value).humanReadableName} (${maybeCredential.value}). Expecting ${n} sign request${n === 1 ? '' : 's'}`);
    // 2 timeouts. 
    // - One for just collecting all requests in the session.
    Effect.runFork(pipe(
      effunct(this.abortSession)(session, true),
      Effect.delay(`${SIGN_REQUESTS_COLLECTION_TIMEOUT_SECONDS} seconds`)
    ));
    // - Another which abandons the session if the actual prf flow hasn't happened yet  
    Effect.runFork(pipe(
      effunct(this.abortSession)(session, false),
      Effect.delay(`${timeoutSeconds} seconds`)
    ));
  }

  private isSignRequestInSession(session: ActiveSession, signRequest: SignInput): Option.Option<{index: number}> {
    if (session.pubkey !== signRequest.pubkey.authorizedKey) {
      return Option.none();
    }
    const trustedParentPid = session.definition.expectedCommonAncestorPID;
    let foundTrustedParentPid = false;
    for (let i = 0; i < signRequest.callerTree.length; ++i) {
      if (signRequest.callerTree[i]!.pid === trustedParentPid) {
        foundTrustedParentPid = true;
        break;
      }
    }
    if (!foundTrustedParentPid) {
      return Option.none();
    }
    for (let i = 0; i < session.definition.expectedSignRequests.length; ++i) {
      const { expectedCallerChain } = session.definition.expectedSignRequests[i]!;
      let j = 0;
      for (; j < expectedCallerChain.length; ++j) {
        const expected = expectedCallerChain[j]!;
        const actual = signRequest.callerTree[j];
        if (
          actual.command !== expected.command ||
          Option.getOrNull(actual.directory) !== Option.getOrNull(expected.directory)
        ) {
          break;
        }
      }
      if (j === expectedCallerChain.length) {
        // Found match
        return Option.some({index: i});
      }
    }
    return Option.none();
  }

  private *cacheKey(keyPair: SSHKeyPair, credentialId: CredentialId, cacheMinutes: number): EffectGen<void> {
    const pubkey = keyPair.pubkey.authorizedKey;
    this.keyCache.set(pubkey, keyPair);
    Effect.runFork(pipe(
      Effect.sync(() => { this.keyCache.delete(pubkey); }),
      Effect.andThen(Effect.log(`Cache entry revoked for ${pubkey} (${credentialId.humanReadableName}) after ${cacheMinutes} minutes`)),
      Effect.delay(`${cacheMinutes} minutes`)
    ));
    yield* Effect.log(`Cached key ${pubkey} (${credentialId.humanReadableName}) for ${cacheMinutes} minutes`);
  }

  private *resolveAllSignRequests(session: ActiveSession): EffectGen<void> {
    // By setting it to none here, we technically do allow parallel sessions, the
    // caveat is there's an expectation that all requests for a session are retrieved
    // in a short time frame. In the future we may have a backlog of non matching signing requests
    // and sessions
    this.activeSession = Option.none();
    const credential = new CredentialId(session.credentialId);

    const cachedKeyPair = this.keyCache.get(session.pubkey);
    let prfResult: Result.Result<PrfResult, SessionError>;
    if (cachedKeyPair) {
      yield* Effect.log(`Using cached key for session ${session.id}`);
      prfResult = Result.succeed({ keyPair: cachedKeyPair, credentialId: credential });
    } else {
      prfResult = yield* pipe(
        effunct(prfFlow)(PrfInput.DerivePubkeyForRequests({session})),
        Effect.scoped,
        Effect.provide(this.context),
        Effect.result
      );
      if (Result.isSuccess(prfResult)) {
        const { keyPair } = prfResult.success;
        const derivedPubkey = keyPair.pubkey.authorizedKey;
        if (derivedPubkey !== session.pubkey) {
          yield* Effect.log(`PRF derived pubkey ${derivedPubkey} but session expects ${session.pubkey}`);
          prfResult = Result.fail(SessionError.cases.InternalError.make({
            reason: `PRF derived pubkey ${derivedPubkey} does not match session pubkey ${session.pubkey}`
          }));
        } else if (prfResult.success.cacheMinutes !== undefined) {
          yield* this.cacheKey(keyPair, credential, prfResult.success.cacheMinutes);
        }
      }
    }

    session.completed = true;
    if (Result.isFailure(prfResult)) {
      yield* Effect.log(`PRF flow failed for session ${session.id}: ${JSON.stringify(prfResult.failure)}`);
    } else {
      yield* Effect.log(`PRF flow succeeded for session ${session.id}`);
    }
    let totalSigned = 0;
    for (const req of session.receivedSignRequests) {
      if (Result.isSuccess(prfResult)) {
        const { keyPair } = prfResult.success;
        const sigResult = yield* Effect.result(Effect.try({
          try: () => keyPair.sign(req.signRequest.data),
          catch: (e) => SessionError.cases.InternalError.make({ reason: String(e) }),
        }));
        if (Result.isSuccess(sigResult)) {
          totalSigned++;
          yield* Effect.log(`(${totalSigned}/${session.receivedSignRequests.length}) Signed ${req.signRequest.data.length} bytes for session ${session.id}`);
          yield* Deferred.succeed(req.deferredResponse, sigResult.success);
        } else {
          yield* Effect.log(`Signing failed for session ${session.id}: ${JSON.stringify(sigResult.failure)}`);
          yield* Deferred.fail(req.deferredResponse, sigResult.failure);
        }
      } else {
        yield* Deferred.fail(req.deferredResponse, prfResult.failure);
      }

    }
  }

  *sign(signRequest: SignInput): EffectGen<Buffer, SessionError> {
    const {pubkey, callerTree} = signRequest;
    // On the no active session case. We create one.
    if (Option.isNone(this.activeSession)) {
      yield* Effect.log(`Received sign request when no session exists. Chain:\n${renderCallerTree(callerTree.slice(-3))}`);
      yield* this.startSession({
        expectedCommonAncestorPID: callerTree[callerTree.length - 1].pid,
        expectedSignRequests: [{
          expectedCallerChain: callerTree
        }],
        timeoutSeconds: DEFAULT_SESSION_TIMEOUT_SECONDS,
        pubkey: pubkey.authorizedKey
      })
    }
    if (Option.isNone(this.activeSession)) {
      return yield* Effect.fail(SessionError.cases.InternalError.make({
        reason: "Invariant violation. Active session not set after calling startSession"
      }));
    }
    const session = this.activeSession.value;
    const maybeIndex = this.isSignRequestInSession(session, signRequest);
    if (Option.isNone(maybeIndex)) {
      // TODO: we could instead create a queue of backed-up sign requests and give
      //       a very short window for each session to collect its requests.
      return yield* Effect.fail(SessionError.cases.InterruptingSession.make({
        id: session.id
      }));
    }
    const {index} = maybeIndex.value;
    const deferredResponse = yield* Deferred.make<Buffer, SessionError>();
    session.receivedSignRequests[index] = {
      deferredResponse,
      signRequest
    }
    session.totalReceived++;
    const totalExpected = session.definition.expectedSignRequests.length;
    yield* Effect.log(`Got matching signature request. ${totalExpected - session.totalReceived} remaining`);
    if (session.totalReceived > totalExpected) {
      return yield* Effect.fail(SessionError.cases.InternalError.make({
        reason: `Only expected to get ${totalExpected} signature requests. Got ${session.totalReceived} instead`
      }));
    }

    if (session.totalReceived === totalExpected) {
      yield* Effect.log(`All ${totalExpected} expected signature requests received for session ${session.id}. Initiating passkey verification.`);
      yield* this.resolveAllSignRequests(session);
    }

    return yield* Deferred.await(deferredResponse);
  }

  *setup(input: SetupInput): EffectGen<SetupOutput, SessionError> {
    const { keyPair, credentialId: derivedCredentialId, cacheMinutes } = yield* pipe(
      effunct(prfFlow)(PrfInput.DerivePubkeyOnly({ pubkey: input.pubkey, credentialId: input.credentialId, username: input.username })),
      Effect.scoped,
      Effect.provide(this.context)
    );

    const derivedPubkey = keyPair.pubkey.authorizedKey;

    if (Option.isSome(input.pubkey) && derivedPubkey !== input.pubkey.value) {
      return yield* Effect.fail(SessionError.cases.PubkeyMismatch.make({ expected: input.pubkey.value, derived: derivedPubkey }));
    }

    yield* Effect.log(`Derived key for ${derivedCredentialId.humanReadableName} (${derivedCredentialId.base58})`);

    yield* pipe(
      effunct(this.dependencies.KeyMapStore.addKey)(keyPair.pubkey, derivedCredentialId.base58),
      Effect.mapError(reason => SessionError.cases.InternalError.make({ reason }))
    );

    if (cacheMinutes !== undefined) {
      yield* this.cacheKey(keyPair, derivedCredentialId, cacheMinutes);
    }

    return { pubkey: derivedPubkey, credentialId: derivedCredentialId.base58 };
  }

  public static RpcLayerLive = pipe(
    RpcServer.layerHttp({ group: AgentRpcGroup, path: "/rpc", protocol: "http" }),
    Layer.provideMerge(AgentRpcGroup.toLayer({
      GetVersion: () => Effect.succeed({ version: CURRENT_VERSION }),
      StartSession: using(Session).startSession,
      Setup: using(Session).setup,
    })),
    HttpRouter.serve,
    Layer.provideMerge(BunHttpServer.layer({ port: AGENT_PORT })),
    Layer.provideMerge(RpcSerialization.layerJson),
    Layer.provideMerge(this.Layer)
  )
}
