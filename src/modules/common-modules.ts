import { interfaces } from "effective-modules";
import type { IOSPlatform } from "./os-platform/interface";

export enum CommonModules {
  OSPlatform = "OSPlatform",
}

export const commonModules = interfaces<CommonModules, {
  OSPlatform: IOSPlatform;
}>(CommonModules);
