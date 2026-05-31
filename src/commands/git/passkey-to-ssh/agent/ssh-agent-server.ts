import { Effect, Layer } from "effect";
import type { EffectGen } from "effective-modules";
import { commonModules } from "../../../../modules/common-modules";
import { agentModules } from "../../../../modules/agent-modules";
import { AGENT_SOCK_FILE_PATH } from "../../../../common/constants";
import { log } from "../../../../common/log";

const SSH2_AGENTC_EXTENSION = 27;
const SSH2_AGENTC_REQUEST_IDENTITIES = 11;
const SSH2_AGENTC_SIGN_REQUEST = 13;
const SSH2_AGENT_FAILURE = 5;

function failureResponse(): Buffer {
  const r = Buffer.alloc(5);
  r.writeUInt32BE(1, 0);
  r[4] = SSH2_AGENT_FAILURE;
  return r;
}

function runGen<A>(gen: EffectGen<A, never>): Promise<A> {
  return Effect.runPromise(Effect.gen(function* () { return yield* gen; }));
}

export const sshAgentServerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const osPlatform = yield* commonModules.OSPlatform;
    const sshAgent = yield* agentModules.SSHAgent;
    yield* osPlatform.startSocketServer(AGENT_SOCK_FILE_PATH, async (data) => {
      const msgType = data[4];
      log(`[ssh-agent] received message type ${msgType}`);
      if (msgType === SSH2_AGENTC_EXTENSION) return runGen(sshAgent.handleExtension(data));
      if (msgType === SSH2_AGENTC_REQUEST_IDENTITIES) return runGen(sshAgent.handleRequestIdentities());
      if (msgType === SSH2_AGENTC_SIGN_REQUEST) return runGen(sshAgent.handleSignRequest(data));
      return Promise.resolve(failureResponse());
    });
    log(`[ssh-agent] listening on ${AGENT_SOCK_FILE_PATH}`);
  })
);
