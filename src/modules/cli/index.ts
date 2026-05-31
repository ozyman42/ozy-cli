import { interfaces } from "effective-modules";
import type { IGit } from "./git/interface";
import type { IGitHub } from "./github/interface";
import type { IAgentClient } from "./agent-client/interface";

export enum CLIModules {
  Git = "Git",
  GitHub = "GitHub",
  AgentClient = "AgentClient",
}

export const cliModules = interfaces<CLIModules, {
  Git: IGit;
  GitHub: IGitHub;
  AgentClient: IAgentClient;
}>(CLIModules);
