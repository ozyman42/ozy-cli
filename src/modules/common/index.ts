import { interfaces } from "effective-modules";
import type { IOSPlatform } from "./os-platform/interface";
import type { IKeyMapStore } from "./kep-map-store/interface";
import type { ICrypto } from "./crypto/interface";
import type { ISSHConfig } from "./ssh-config/interface";

export enum CommonModules {
  OSPlatform = "OSPlatform",
  KeyMapStore = "KeyMapStore",
  Crypto = "Crypto",
  SSHConfig = "SSHConfig",
}

export const commonModules = interfaces<CommonModules, {
  OSPlatform: IOSPlatform;
  KeyMapStore: IKeyMapStore;
  Crypto: ICrypto;
  SSHConfig: ISSHConfig;
}>(CommonModules);
