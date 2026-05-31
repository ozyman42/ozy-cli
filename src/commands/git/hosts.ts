import { Effect } from "effect";
import { makeCommand } from "@/common/command";
import { log } from "@/common/log";
import { commonModules } from "@/modules/common";
import { SSHConfigImpl } from "@/modules/common/ssh-config/impl";

export const hosts = makeCommand('hosts', 'show all configured github.com SSH hosts', () =>
  Effect.gen(function* () {
    const sshConfig = yield* commonModules.SSHConfig;
    const config = yield* sshConfig.getSSHConfig();
    const gitHosts: string[] = [];
    for (const host in config) {
      if (config[host]!.HostName === 'github.com') {
        gitHosts.push(host);
      }
    }
    log('Available hosts:');
    gitHosts.forEach(host => { log(` - ${host}`); });
  }).pipe(Effect.provide(SSHConfigImpl.Layer))
);
