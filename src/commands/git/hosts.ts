import { makeCommand } from "../../common/command";
import { log } from "../../common/log";
import { Err, Ok, type Result } from "../../common/result";
import { getSSHConfig } from "../../common/ssh";

export enum ListGitHostsError {
  MalformedSSHConfigFile = 'MalformedSSHConfigFile'
}

async function listHosts(): Promise<Result<true, ListGitHostsError>> {
  const sshConfig = await getSSHConfig();
  if (!sshConfig.success) {
    return Err(
      ListGitHostsError.MalformedSSHConfigFile,
      `${sshConfig.error}: ${sshConfig.reason}`
    );
  }
  const gitHosts: string[] = [];
  for (const host in sshConfig.value) {
    const hostConfig = sshConfig.value[host];
    if (hostConfig.HostName === 'github.com') {
      gitHosts.push(host);
    }
  }
  log('Available hosts:');
  gitHosts.forEach(host => { log(` - ${host}`); });
  return Ok(true);
}

export const hosts = makeCommand('hosts', 'show all configured github.com SSH hosts', listHosts);
