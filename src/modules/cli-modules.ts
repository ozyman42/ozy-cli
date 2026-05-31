import { interfaces } from "effective-modules";
import type { IGit } from "./git/interface";
import type { IGitHub } from "./github/interface";
import type { IAgentClient } from "./agent-client/interface";

export enum Modules {
  Git = "Git",
  GitHub = "GitHub",
  AgentClient = "AgentClient",
}

export const modules = interfaces<Modules, {
  Git: IGit;
  GitHub: IGitHub;
  AgentClient: IAgentClient;
}>(Modules);
