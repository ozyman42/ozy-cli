import { $ } from "bun";
import { default as SSHConfig } from "ssh-config";
import * as fs from 'node:fs/promises';
import expandTilde from 'expand-tilde';

function log(...stuff: any[]) {
  console.log(...stuff);
}

enum GitConfigLocation {
  Local = 'local',
  Global = 'global'
}

async function setGitValue(k: string, v: string, location: GitConfigLocation) {
  let prefix: {[location in GitConfigLocation]: string} = {
    [GitConfigLocation.Local]:  ' (local)',
    [GitConfigLocation.Global]: '(global)'
  };
  try {
    await $`git config --${location} "${k}" "${v}" 1>/dev/null`;
    log(`${prefix[location]} ${k}=${v}`);
  } catch (e) {
    let error = e as Error;
    log(`unable to set git config key of "${k}" to "${v}" due to`);
    log(error);
  }
}

async function isGitRepository() {
  try {
    // This command checks if the .git directory exists in the current directory
    await $`git rev-parse --is-inside-work-tree 1>/dev/null`;
    return true;
  } catch (error) {
    log(error)
    return false;
  }
}

async function getGitRemoteOrigin() {
  try {
    const result = (await $`git config --get remote.origin.url`.quiet()).text();
    return result.trim();
  } catch (error) {
    // const e = error as Error;
    // log("Error fetching remote origin:", e.message);
    return undefined;
  }
}

async function getSSHConfig(sshConfigPath: string): Promise<SSHConfig | undefined> {
  try {
    const sshFileContent = await fs.readFile(sshConfigPath);
    return SSHConfig.parse(sshFileContent.toString());
  } catch (e) {
    const error = e as Error;
    log('unable to parse ssh file');
    log(error);
    return undefined;
  }
}

async function getUsername(sshHost: string): Promise<string | undefined> {
  try {
    const { stdout } = (await $`ssh -T ${sshHost} 2>&1`.nothrow().quiet());
    const output = stdout.toString().trim();
    if (output.startsWith('ssh: Could not resolve')) {
      log(output);
      return undefined;
    } else if (output.startsWith('Hi ')) {
      const name = output.substring('Hi '.length).split('!')[0];
      return name;
    } else {
      log('Unable to discern output ssh -T output format');
      log(output);
      return undefined;
    }
  } catch (e) {
    const error = e as Error;
    log('unable to get username due to');
    log(error);
    return undefined;
  }
}

export async function gitSetup() {
  const isRepo = await isGitRepository();
  if (!isRepo) {
    log("Current directory is not a Git repository.");
    return;
  }
  const remoteOrigin = await getGitRemoteOrigin();
  if (!remoteOrigin) {
    log("No remote origin configured.");
    return;
  }
  if (!remoteOrigin.startsWith("git@")) {
    log(`Remote origin '${remoteOrigin}' isn't an ssh-based origin`);
    return;
  }
  const sshHost = remoteOrigin.substring("git@".length).split(":")[0];
  // Load ssh config
  const sshFilePath = expandTilde('~/.ssh/config');
  const sshFileExists = await fs.exists(sshFilePath);
  if (!sshFileExists) {
    log(`No file found at ${sshFilePath}`);
    return;
  }
  const sshConfigFile = await getSSHConfig(sshFilePath);
  if (!sshConfigFile) {
    log(`Malformed ssh config file at ${sshFilePath}`);
    return;
  }
  const result = sshConfigFile.find({Host: sshHost});
  if (!result) {
    log(`No existing ssh config entry for the origin remote host '${sshHost}'`);
    log(`Existing Hosts are`);
    const hosts: string[] = [];
    for (const line of sshConfigFile) {
      const {param: curParam, value: curValue} = (line as any);
      if (curParam === 'Host') {
        hosts.push(curValue);
      }
    }
    hosts.forEach(host => { log(` - ${host}`) });
    return;
  }
  const {config, param, value} = (result as any);
  if (param !== 'Host') {
    log(`Expected param of 'Host' instead got '${param}'`);
    return;
  }
  if (value !== sshHost) {
    log(`Expected value of '${sshHost}' instead got '${value}'`);
    return;
  }
  let identityFile: string | undefined = undefined;
  for (const val of config) {
    const { param: innerParam, value: innerValue } = val;
    if (innerParam !== 'IdentityFile') continue;
    identityFile = expandTilde(innerValue);
    break;
  }
  if (!identityFile) {
    log(`No IdentityFile entry found for Host '${sshHost}'`);
    return;
  }
  const identityFilePath = `${identityFile}.pub`;
  if (!(await fs.exists(identityFilePath))) {
    log(`No such file exists ${identityFilePath}`);
    return;
  }
  // Get email from pub key
  const email = (await fs.readFile(identityFilePath)).toString().trim().split(' ').pop();
  if (!email) {
    log(`No email found in file ${identityFilePath}`);
    return;
  }
  // Get username from sshHost
  const username = await getUsername(sshHost);
  if (!username) {
    log(`Could not determine username. Check if pubkey at ${identityFilePath} is saved in github as an AuthN key`);
    return;
  }
  // Set values
  await setGitValue('commit.gpgsign', 'true', GitConfigLocation.Global);
  await setGitValue('tag.gpgsign', 'true', GitConfigLocation.Global);
  await setGitValue('gpg.format', 'ssh', GitConfigLocation.Global);
  await setGitValue('user.signingkey', identityFilePath.replaceAll("\\", "/"), GitConfigLocation.Local);
  await setGitValue('user.name', username, GitConfigLocation.Local);
  await setGitValue('user.email', email, GitConfigLocation.Local);
}
