import { Effect, pipe, Result, Layer } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import type { ISSHAgent } from "./interface";
import type { CallerProcess } from "@/modules/common/os-platform/interface";
import { agentModules } from "@/modules/ssh-agent";
import { commonModules } from "@/modules/common";
import { SSHPubkey } from "@/modules/common/crypto/impl";
import { log } from "@/common/log";
import { AGENT_PID_FILE_PATH, AGENT_SOCK_FILE_PATH } from "@/common/constants";
import { writeFileSync } from "node:fs";

const SSH2_AGENT_FAILURE = 5;
const SSH2_AGENT_REQUEST_IDENTITIES = 11;
const SSH2_AGENT_IDENTITIES_ANSWER = 12;
const SSH2_AGENT_SIGN_REQUEST = 13;
const SSH2_AGENT_SIGN_RESPONSE = 14;
const SSH2_AGENT_EXTENSION = 27;

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function sshString(s: Buffer): Buffer {
  return Buffer.concat([u32(s.length), s]);
}

function buildSignResponse(keyType: string, signature: Buffer): Buffer {
  const sigBlob = Buffer.concat([sshString(Buffer.from(keyType)), sshString(signature)]);
  const body = Buffer.concat([Buffer.from([SSH2_AGENT_SIGN_RESPONSE]), sshString(sigBlob)]);
  return Buffer.concat([u32(body.length), body]);
}

function failureResponse(): Buffer {
  const r = Buffer.alloc(5);
  r.writeUInt32BE(1, 0);
  r[4] = SSH2_AGENT_FAILURE;
  return r;
}

const { KeyMapStore, OSPlatform } = commonModules;
const { SSHAgent, Session } = agentModules;

export class SSHAgentImpl extends implementing(SSHAgent).uses(Session, KeyMapStore, OSPlatform) implements ISSHAgent {

  private log(...items: any[]) {
    log(`[ssh-agent]`, ...items);
  }

  *start(): EffectGen<void, string> {
    const { OSPlatform: { startSocketServer } } = this.dependencies;
    const { handleExtension, handleRequestIdentities, handleSignRequest, log } = this;
    yield* startSocketServer(AGENT_SOCK_FILE_PATH, function*(data, callerChain): EffectGen<Buffer> {
      const msgType = data[4];
      switch (msgType) {
        case SSH2_AGENT_EXTENSION:
          log(`received extensions request`);
          return yield* handleExtension(data);
        case SSH2_AGENT_REQUEST_IDENTITIES:
          log(`received request identities request`);
          return yield* handleRequestIdentities();
        case SSH2_AGENT_SIGN_REQUEST:
          log(`received signature request`);
          return yield* handleSignRequest(data, callerChain);
        default:
          log(`received unknown message type ${msgType}`);
          return failureResponse();
      }
    });
    writeFileSync(AGENT_PID_FILE_PATH, process.pid.toString());
    log(`listening on ${AGENT_SOCK_FILE_PATH}`);
  }

  *handleExtension(data: Buffer): EffectGen<Buffer, never> {
    const nameLen = data.readUInt32BE(5);
    const name = data.subarray(9, 9 + nameLen).toString("utf8");
    this.log(`extension request for ${name}`);
    // We don't support any extensions, so we fail this outright.
    return yield* Effect.sync(() => failureResponse());
  }

  *handleRequestIdentities(): EffectGen<Buffer, never> {
    const keyMapStore = this.dependencies.KeyMapStore;
    const listResult = yield* pipe(
      effunct(keyMapStore.listPubkeys)(),
      Effect.result
    );
    const pubkeys = Result.isSuccess(listResult) ? listResult.success : [];
    if (Result.isFailure(listResult)) {
      this.log(`Failure to retrieve keys ${listResult.failure}`);
    }
    this.log(`Total keys ${pubkeys.length}`);
    if (pubkeys.length === 0) {
      const body = Buffer.concat([Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]), u32(0)]);
      return Buffer.concat([u32(body.length), body]);
    }
    const keyEntries = pubkeys.map(pubkey => {
      return Buffer.concat([sshString(pubkey.wire), sshString(Buffer.alloc(0))]);
    });
    const body = Buffer.concat([
      Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
      u32(pubkeys.length),
      ...keyEntries,
    ]);
    return Buffer.concat([u32(body.length), body]);
  }

  *handleSignRequest(data: Buffer, callerChain: CallerProcess[]): EffectGen<Buffer, never> {
    const session = this.dependencies.Session;
    let offset = 5; // skip length(4) + type(1)
    const keyBlobLen = data.readUInt32BE(offset); offset += 4;
    const pubkeyWire = Buffer.from(data.subarray(offset, offset + keyBlobLen)); offset += keyBlobLen;
    const dataToSignLen = data.readUInt32BE(offset); offset += 4;
    const dataToSign = Buffer.from(data.subarray(offset, offset + dataToSignLen));

    const pubkey = SSHPubkey.fromWire(pubkeyWire);

    this.log(`Sign request for pubkey ${pubkey.authorizedKey}`, callerChain.slice(-3));
    const signResult = yield* pipe(
      effunct(session.sign)({
        data: dataToSign,
        pubkey,
        callerTree: callerChain
      }),
      Effect.result
    );
    return Result.isSuccess(signResult) ? buildSignResponse(pubkey.keyType, signResult.success) : failureResponse();
  }

  public static ServiceLayer = Layer.effectDiscard(Effect.gen(function*() {
    const sshAgent = yield* agentModules.SSHAgent;
    yield* sshAgent.start();
  })).pipe(Layer.provideMerge(this.Layer))
}
