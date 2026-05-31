import type { CallerProcess } from "@/modules/common/os-platform/interface";
import { Schema } from "effect";
import type { EffectGen } from "effective-modules";
import type { SSHPubkey } from "@/modules/common/crypto/impl";

export const SessionError = Schema.TaggedUnion({
  SessionTimedOut: {seconds: Schema.Number},
  WebAuthnCancelled: {},
  InternalError: {reason: Schema.String },
  PubkeyMismatch: {expected: Schema.String, derived: Schema.String },
  PubkeyNotRegistered: {pubkey: Schema.String},
  InterruptingSession: {id: Schema.String},
  UnexpectedSignRequest: {},
});
export type SessionError = Schema.Schema.Type<typeof SessionError>

export const SetupInput = Schema.Struct({
  pubkey: Schema.OptionFromNullOr(Schema.String),
  credentialId: Schema.OptionFromNullOr(Schema.String),
  username: Schema.String,
});
export type SetupInput = Schema.Schema.Type<typeof SetupInput>;

export const SetupOutput = Schema.Struct({
  pubkey: Schema.String,
  credentialId: Schema.String
});
export type SetupOutput = Schema.Schema.Type<typeof SetupOutput>;

export interface SignInput {
  data: Buffer;
  pubkey: SSHPubkey;
  callerTree: CallerProcess[];
}

export const ExpectedSignRequest = Schema.Struct({
  expectedCallerChain: Schema.Array(Schema.Struct({
    command: Schema.String,
    directory: Schema.OptionFromNullOr(Schema.String)
  }))
});
export type ExpectedSignRequest = Schema.Schema.Type<typeof ExpectedSignRequest>;

export const StartSessionInput = Schema.Struct({
  expectedSignRequests: Schema.Array(ExpectedSignRequest),
  expectedCommonAncestorPID: Schema.Number,
  timeoutSeconds: Schema.Number,
  pubkey: Schema.String
});
export type StartSessionInput = Schema.Schema.Type<typeof StartSessionInput>;

export interface ISession {
  startSession(input: StartSessionInput): EffectGen<void, SessionError>;
  sign(input: SignInput): EffectGen<Buffer, SessionError>;
  /*
    Runs PRF directly. Create key from existing credential or create new credential,
    verify against existing pubkey (if pubkey sent).
    Register it in map.
  */
  setup(input: SetupInput): EffectGen<SetupOutput, SessionError>;
}

