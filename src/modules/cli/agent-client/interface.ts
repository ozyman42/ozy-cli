import type { EffectGen } from "effective-modules";
import type { AgentRpcGroup } from "@/modules/ssh-agent/session/interface-rpc";
import type { RpcClient, RpcClientError as RpcClientErrorModule, RpcGroup } from "effect/unstable/rpc";
import { Data } from "effect";

export type AgentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<AgentRpcGroup>, RpcClientErrorModule.RpcClientError>;

export namespace AgentClientError {
  export class UsageError<E> extends Data.TaggedError("AgentClientUsageError")<{ readonly cause: E }> {}
  export class ClientError extends Data.TaggedError("AgentClientError")<{ readonly reason: string }> {}
}
export type AgentClientError<E> = AgentClientError.UsageError<E> | AgentClientError.ClientError;

export interface IAgentClient {
  killIfRunning(): EffectGen<void, string>;
  usingClient<A, E>(use: (client: AgentRpcClient) => EffectGen<A, E>): EffectGen<A, AgentClientError<E>>;
}
