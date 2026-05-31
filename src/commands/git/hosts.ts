import { Effect } from "effect";
import { makeCommand } from "../../common/command";
import { log } from "../../common/log";
import { getSSHConfig } from "../../common/ssh";

export const hosts = makeCommand('hosts', 'show all configured github.com SSH hosts', () =>
  Effect.gen(function* () {
    const sshConfig = yield* getSSHConfig();
    const gitHosts: string[] = [];
    for (const host in sshConfig) {
      const hostConfig = sshConfig[host];
      if (hostConfig.HostName === 'github.com') {
        gitHosts.push(host);
      }
    }
    log('Available hosts:');
    gitHosts.forEach(host => { log(` - ${host}`); });
  })
);
