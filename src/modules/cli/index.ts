import { interfaces } from "effective-modules";
import type { IGit } from "./git/interface";
import type { IGitHub } from "./github/interface";
import type { IAgentClient } from "./agent-client/interface";
import type { INpm } from "./npm/interface";
import type { ITemplates } from "./templates/interface";
import type { IPackage } from "./package/interface";
import type { ICloudflare } from "./cloudflare/interface";

export enum CLIModules {
  Git = "Git",
  GitHub = "GitHub",
  AgentClient = "AgentClient",
  Npm = "Npm",
  Templates = "Templates",
  Package = "Package",
  Cloudflare = "Cloudflare",
}

export const cliModules = interfaces<CLIModules, {
  Git: IGit;
  GitHub: IGitHub;
  AgentClient: IAgentClient;
  Npm: INpm;
  Templates: ITemplates;
  Package: IPackage;
  Cloudflare: ICloudflare;
}>(CLIModules);
