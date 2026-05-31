import type { EffectGen } from "effective-modules";
import type { CallerProcess } from "@/modules/common/os-platform/interface";

export interface ISSHAgent {
  start(): EffectGen<void, string>;
  handleExtension(data: Buffer): EffectGen<Buffer, never>;
  handleRequestIdentities(): EffectGen<Buffer, never>;
  handleSignRequest(data: Buffer, callerChain: CallerProcess[]): EffectGen<Buffer, never>;
}
