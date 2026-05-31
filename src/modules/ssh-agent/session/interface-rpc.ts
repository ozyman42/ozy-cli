import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { SessionError, SetupInput, SetupOutput, StartSessionInput } from "./interface";

const GetVersionRpc = Rpc.make("GetVersion", {
  payload: {},
  success: Schema.Struct({ version: Schema.String }),
  error: Schema.Never,
});

const SetupRpc = Rpc.make("Setup", {
  payload: SetupInput,
  success: SetupOutput,
  error: SessionError,
});

const StartSessionRpc = Rpc.make("StartSession", {
  payload: StartSessionInput,
  success: Schema.Void,
  error: SessionError,
});

export const AgentRpcGroup = RpcGroup.make(GetVersionRpc, StartSessionRpc, SetupRpc);
export type AgentRpcGroup = typeof AgentRpcGroup;
