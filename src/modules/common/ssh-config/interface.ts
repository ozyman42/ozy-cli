import { Schema } from "effect";
import type { Option } from "effect";
import type { EffectGen } from "effective-modules";
import type { SSHPubkey } from "@/modules/common/crypto/impl";

export const SSHConfigSection = Schema.Struct({
  HostName: Schema.String,
  User: Schema.String,
  IdentityFile: Schema.optional(Schema.String),
  AddKeysToAgent: Schema.optional(Schema.String),
  IdentitiesOnly: Schema.optional(Schema.String),
  IdentityAgent: Schema.optional(Schema.String),
});
export type SSHConfigSection = Schema.Schema.Type<typeof SSHConfigSection>;
export type SSHConfigHosts = Record<string, SSHConfigSection>;

export interface WriteHostInput {
  section: SSHConfigSection;
}

export interface WritePubkeyInput {
  name: string;
  comment: Option.Option<string>;
  pubkey: SSHPubkey;
}

export interface ISSHConfig {
  getSSHConfig(): EffectGen<SSHConfigHosts, string>;
  writeHost(input: WriteHostInput): EffectGen<void, string>;
  writePubkey(input: WritePubkeyInput): EffectGen<{pubkeyPath: string}, string>;
  listPubkeyFiles(): EffectGen<{name: string, content: string}[], string>;
  getPubkeyPath(name: string): string;
}
