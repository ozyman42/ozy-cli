import { $ } from "bun";
import * as fs from 'node:fs/promises';
import expandTilde from 'expand-tilde';
import { makeCommand } from '../../common/command';
import { log } from '../../common/log';
import { type Result, Ok, Err } from '../../common/result';
import { getSSHConfig, getUsername } from "../../common/ssh";

enum GitConfigLocation {
  Local = 'local',
  Global = 'global'
}

async function setGitValue(k: string, v: string, location: GitConfigLocation): Promise<Result<true, false>> {
  let prefix: {[location in GitConfigLocation]: string} = {
    [GitConfigLocation.Local]:  ' (local)',
    [GitConfigLocation.Global]: '(global)'
  };
  try {
    await $`git config --${location} "${k}" "${v}" 1>/dev/null`;
    log(`${prefix[location]} ${k}=${v}`);
    return Ok(true);
  } catch (e) {
    let error = e as Error;
    const errorStr = `unable to set git config key of "${k}" to "${v}" due to\n${error.toString()}`;
    log(errorStr);
    return Err(false, errorStr);
  }
}

async function isGitRepository() {
  try {
    // This command checks if the .git directory exists in the current directory
    await $`git rev-parse --is-inside-work-tree 1>/dev/null`;
    return true;
  } catch (error) {
    log(error);
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

export enum GitSetupError {
  NotInGitDirectoryError = 'NotInGitDirectoryError',
  NoRemoteOriginError = 'NoRemoteOriginError',
  RemoteOriginIsNotSSHError = 'RemoteOriginIsNotSSHError',
  SSHConfigFileMissingError = 'SSHConfigFileMissingError',
  SSHConfigFileMalformedError = 'SSHConfigFileMalformedError',
  SSHConfigHostMissingError = 'SSHConfigHostMissingError',
  SSHPubkeyMissingError = 'SSHPubkeyMissingError',
  SSHPubkeyMalformedError = 'SSHPubkeyMalformedError',
  SSHPubkeyNotAttachedToUserError = 'SSHPubkeyNotAttachedToUserError'
}

async function gitSetup(): Promise<Result<true, GitSetupError>> {
  // 1. Are we in a git repo?
  const isRepo = await isGitRepository();
  if (!isRepo)
    return Err(
      GitSetupError.NotInGitDirectoryError,
      "Current directory is not a Git repository."
    );

  // 2. Does this git repo we're in have a remote named "origin" configured?
  const remoteOrigin = await getGitRemoteOrigin();
  if (!remoteOrigin)
    return Err(
      GitSetupError.NoRemoteOriginError,
      "No remote origin configured."
    );

  // 3. Is this remote origin an SSH remote?
  if (!remoteOrigin.startsWith("git@"))
    return Err(
      GitSetupError.RemoteOriginIsNotSSHError,
      `Remote origin '${remoteOrigin}' isn't an ssh-based origin`
    );
  const sshHost = remoteOrigin.substring("git@".length).split(":")[0];
  
  // 4. Does the current user have SSH configured? If so load it
  const sshConfigFileResult = await getSSHConfig();
  if (!sshConfigFileResult.success)
    return Err(
      GitSetupError.SSHConfigFileMalformedError,
      `${sshConfigFileResult.error}: ${sshConfigFileResult.reason}`
    );

  // 5. Does the SSH config have a host entry for the origin remote?
  const sshConfigFile = sshConfigFileResult.value;
  if (!(sshHost in sshConfigFile)) {
    const errorMsg = [
      `No existing ssh config entry for the origin remote host '${sshHost}'`,
      `Existing Hosts are`,
      ...Object.keys(sshConfigFile)
    ].join("\n");
    return Err(
      GitSetupError.SSHConfigHostMissingError,
      errorMsg
    );
  }

  // 6. Get the AuthN pubkey from the SSH config
  const hostConfig = sshConfigFile[sshHost];
  if (!hostConfig.IdentityFile)
    return Err(
      GitSetupError.SSHPubkeyMissingError,
      `No IdentityFile entry found for Host '${sshHost}'`
    );
  const identityFile = expandTilde(hostConfig.IdentityFile);
  
  const identityFilePath = `${identityFile}.pub`;
  if (!(await fs.exists(identityFilePath)))
    return Err(
      GitSetupError.SSHPubkeyMissingError,
      `No such file exists ${identityFilePath}`
    );
  
  // 7. Get email from pubkey
  const email = (await fs.readFile(identityFilePath)).toString().trim().split(' ').pop();
  if (!email)
    return Err(
      GitSetupError.SSHPubkeyMalformedError,
      `No email found in file ${identityFilePath}`
    );
  
  // 8. Get username by testing the SSH connection
  const username = await getUsername(sshHost);
  if (!username)
    return Err(
      GitSetupError.SSHPubkeyNotAttachedToUserError,
      `Could not determine username. Check if pubkey at ${identityFilePath} is saved in github as an AuthN key`
    );
  
  // 9. Set git config values
  await setGitValue('commit.gpgsign', 'true', GitConfigLocation.Global);
  await setGitValue('tag.gpgsign', 'true', GitConfigLocation.Global);
  await setGitValue('gpg.format', 'ssh', GitConfigLocation.Global);
  await setGitValue('user.signingkey', identityFilePath.replaceAll("\\", "/"), GitConfigLocation.Local);
  await setGitValue('user.name', username, GitConfigLocation.Local);
  await setGitValue('user.email', email, GitConfigLocation.Local);

  return Ok(true);
}

export const setup = makeCommand('setup', 'setup verified git commits for current repo', gitSetup);
