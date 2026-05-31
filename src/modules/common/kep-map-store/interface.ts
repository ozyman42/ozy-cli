import { Option } from "effect";
import type { EffectGen } from "effective-modules";
import type { SSHPubkey } from "@/modules/common/crypto/impl";

export interface IKeyMapStore {
  listPubkeys(): EffectGen<SSHPubkey[], string>;
  getCredentialByPubkey(pubkey: SSHPubkey): EffectGen<Option.Option<string>, string>;
  addKey(pubkey: SSHPubkey, credentialId: string): EffectGen<void, string>;
}
