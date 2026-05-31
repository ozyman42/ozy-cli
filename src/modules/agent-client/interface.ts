import type { EffectGen } from "effective-modules";
import type { AgentRpcGroup } from "../../commands/git/passkey-to-ssh/agent/group";
import type { RpcClient, RpcClientError as RpcClientErrorModule, RpcGroup } from "effect/unstable/rpc";

export type AgentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<AgentRpcGroup>, RpcClientErrorModule.RpcClientError>;

export interface IAgentClient {
  ensureRunning(): EffectGen<void, string>;
  killIfRunning(): EffectGen<void, string>;
  usingClient<A, E>(use: (client: AgentRpcClient) => EffectGen<A, E>): EffectGen<A, E>;
}
