import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Schema } from "effect";
import { SessionError, Action } from "../../../../modules/session/interface";

const GetVersionRpc = Rpc.make("GetVersion", {
  payload: {},
  success: Schema.Struct({ version: Schema.String }),
  error: Schema.Never,
});

export const Actions = Schema.Enum(Action);

export const DeclareSessionRpc = Rpc.make("DeclareSession", {
  payload: {
    context: Schema.Struct({
      repo: Schema.Struct({
        owner: Schema.String,
        name: Schema.String,
        id: Schema.String,
      }),
      user: Schema.Struct({
        login: Schema.String,
      }),
    }),
    actions: Schema.Array(Actions),
    existingKey: Schema.optional(Schema.Struct({
      credentialId: Schema.String,
      pubkey: Schema.String,
    })),
  },
  success: Schema.Struct({
    signingPubkey: Schema.String,
    credentialId: Schema.String,
    deployPubkey: Schema.String,
  }),
  error: Schema.Enum(SessionError),
});

export const AgentRpcGroup = RpcGroup.make(GetVersionRpc, DeclareSessionRpc);
export type AgentRpcGroup = typeof AgentRpcGroup;
