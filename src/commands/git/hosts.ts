import { Effect, pipe } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { makeCommand } from "@/common/command";
import { log } from "@/common/log";
import { commonModules, type CommonModules } from "@/modules/common";
import { SSHConfigImpl } from "@/modules/common/ssh-config/impl";

function* hostsAction(): EffectGen<void, string, CommonModules.SSHConfig> {
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
}

export const hosts = makeCommand('hosts', 'show all configured github.com SSH hosts', function* () {
  yield* pipe(effunct(hostsAction)(), Effect.provide(SSHConfigImpl.Layer));
});
