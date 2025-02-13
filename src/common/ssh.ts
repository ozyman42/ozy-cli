import * as fs from 'node:fs/promises';
import { $ } from 'bun';
import SSHConfig, { LineType } from 'ssh-config';
import { log } from './log';
import { Err, Ok, type Result } from './result';
import { z } from 'zod';
import expandTilde from 'expand-tilde';

const SSHConfigSectionSchema = z.object({
  HostName: z.string(),
  User: z.string(),
  IdentityFile: z.string().optional(),
  AddKeysToAgent: z.string().optional(),
  IdentitiesOnly: z.string().optional()
});

const SSHConfigHostsSchema = z.record(
  z.string(),
  SSHConfigSectionSchema
);

export type SSHConfigHosts = z.infer<typeof SSHConfigHostsSchema>;

export enum GetSSHConfigError {
  SSHConfigFileMissingError = 'SSHConfigFileMissingError',
  ParseError = 'ParseError',
  DuplicateHostError = 'DupublicatHostError',
  EntryNotAHostKeyValuePairError = 'EntryNotAHostKeyValuePairError',
  MissingHostNameError = 'MissingHostNameError',
  MissingUserError = 'MissingUserError',
  MalformedError = 'MalformedError'
}

export async function getSSHConfig(sshConfigPathPartial = '~/.ssh/config'): Promise<Result<SSHConfigHosts, GetSSHConfigError>> {
  const sshConfigPath = expandTilde(sshConfigPathPartial);
  const sshFileExists = await fs.exists(sshConfigPath);
  if (!sshFileExists)
    return Err(
      GetSSHConfigError.SSHConfigFileMissingError,
      `No file found at ${sshConfigPath}`
    );
  try {
    const sshFileContent = await fs.readFile(sshConfigPath);
    const sshFile = SSHConfig.parse(sshFileContent.toString());
    const hosts: SSHConfigHosts = {};
    for (const line of sshFile) {
      if (line.type === LineType.COMMENT) continue;
      const {param: curParam, value: host} = line;
      const valueStr = JSON.stringify(host);
      if (curParam !== 'Host') {
        return Err(
          GetSSHConfigError.EntryNotAHostKeyValuePairError,
          `Unexpected top-level entry in ssh file '${sshConfigPath}': ${curParam}=${valueStr}`
        );
      }
      if (typeof host !== 'string') {
        return Err(
          GetSSHConfigError.EntryNotAHostKeyValuePairError,
          `top-level Host ${curParam} has value of non string '${valueStr}'`
        );
      }
      if (!('config' in line)) {
        return Err(
          GetSSHConfigError.EntryNotAHostKeyValuePairError,
          `top-level non-section detected in ssh file '${sshConfigPath}': ${curParam}=${valueStr}`
        );
      }
      if (host in hosts) {
        return Err(
          GetSSHConfigError.DuplicateHostError,
          `ssh file '${sshConfigPath}' contains duplicate Hosts named '${host}'`
        );
      }
      const keyValues: Record<string, string> = {};
      for (const innerLine of line.config) {
        if (innerLine.type === LineType.COMMENT) continue;
        const { param: innerParam, value: innerValue } = innerLine;
        if (typeof innerValue !== 'string') {
          return Err(
            GetSSHConfigError.MalformedError,
            `ssh file '${sshConfigPath}' at Host '${host}' at key '${innerParam}' has non string value '${innerValue}'`
          );
        }
        keyValues[innerParam] = innerValue;
      }
      const result = SSHConfigSectionSchema.safeParse(keyValues);
      if (!result.success) {
        return Err(
          GetSSHConfigError.MalformedError,
          `malformed section at Host '${host}' due to ${result.error.toString()}`
        );
      }
      hosts[host] = result.data;
    }
    return Ok(hosts);
    
  } catch (e) {
    const error = e as Error;
    return Err(
      GetSSHConfigError.ParseError,
      `unable to parse ssh file ${sshConfigPath}\n${error.toString()}`
    );
  }
}

export async function getUsername(sshHost: string): Promise<string | undefined> {
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
