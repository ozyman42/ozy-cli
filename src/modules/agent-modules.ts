import { interfaces } from "effective-modules";
import type { ISSHAgent } from "./ssh-agent/interface";
import type { ISession } from "./session/interface";
import type { ICrypto } from "./crypto/interface";

export enum AgentModules {
  SSHAgent = "SSHAgent",
  Session = "Session",
  Crypto = "Crypto",
}

export const agentModules = interfaces<AgentModules, {
  SSHAgent: ISSHAgent;
  Session: ISession;
  Crypto: ICrypto;
}>(AgentModules);
