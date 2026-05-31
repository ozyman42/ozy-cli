import { Effect } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import type { ISSHAgent } from "./interface";
import { agentModules } from "../agent-modules";
import { log } from "../../common/log";
import type { SessionContext } from "../session/interface";

const SSH2_AGENT_IDENTITIES_ANSWER = 12;
const SSH2_AGENT_FAILURE = 5;

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function sshString(s: Buffer): Buffer {
  return Buffer.concat([u32(s.length), s]);
}

function failureResponse(): Buffer {
  const r = Buffer.alloc(5);
  r.writeUInt32BE(1, 0);
  r[4] = SSH2_AGENT_FAILURE;
  return r;
}

export class SSHAgentImpl extends implementing(agentModules.SSHAgent).uses(agentModules.Session) implements ISSHAgent {
  *handleExtension(data: Buffer): EffectGen<Buffer, never> {
    const nameLen = data.readUInt32BE(5);
    const name = data.subarray(9, 9 + nameLen).toString('utf8');
    log(`[ssh-agent] extension request: ${name}`);
    return yield* Effect.sync(() => failureResponse());
  }

  *handleRequestIdentities(): EffectGen<Buffer, never> {
    const session = this.dependencies.Session;
    const pubkeys = yield* session.listKeys();
    return yield* Effect.sync(() => {
      if (pubkeys.length === 0) {
        const body = Buffer.concat([Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]), u32(0)]);
        return Buffer.concat([u32(body.length), body]);
      }
      const keyEntries = pubkeys.map(pubkey => {
        const pubkeyWire = Buffer.from(pubkey.split(' ')[1]!, 'base64');
        return Buffer.concat([sshString(pubkeyWire), sshString(Buffer.alloc(0))]);
      });
      const body = Buffer.concat([
        Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
        u32(pubkeys.length),
        ...keyEntries,
      ]);
      return Buffer.concat([u32(body.length), body]);
    });
  }

  *handleSignRequest(data: Buffer): EffectGen<Buffer, never> {
    const session = this.dependencies.Session;
    let offset = 5; // skip length(4) + type(1)
    const keyBlobLen = data.readUInt32BE(offset); offset += 4;
    const pubkeyWire = Buffer.from(data.subarray(offset, offset + keyBlobLen)); offset += keyBlobLen;
    const dataToSignLen = data.readUInt32BE(offset); offset += 4;
    const dataToSign = Buffer.from(data.subarray(offset, offset + dataToSignLen));

    // TODO: parse context from dataToSign
    const context: SessionContext = { repo: { owner: '', name: '', id: '' }, user: { login: '' } };

    return yield* Effect.gen(function* () {
      return yield* session.sign({ pubkeyWire, dataToSign, context });
    }).pipe(
      Effect.catch(() => Effect.succeed(failureResponse()))
    );
  }
}
