import { interfaces } from "effective-modules";
import type { ISSHAgent } from "./ssh-agent/interface";
import type { ISession } from "./session/interface";

export enum AgentModules {
  SSHAgent = "SSHAgent",
  Session = "Session"
}

export const agentModules = interfaces<AgentModules, {
  SSHAgent: ISSHAgent;
  Session: ISession;
}>(AgentModules);
