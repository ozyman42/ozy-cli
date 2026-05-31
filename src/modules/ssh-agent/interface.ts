import type { EffectGen } from "effective-modules";

export interface ISSHAgent {
  handleExtension(data: Buffer): EffectGen<Buffer, never>;
  handleRequestIdentities(): EffectGen<Buffer, never>;
  handleSignRequest(data: Buffer): EffectGen<Buffer, never>;
}
