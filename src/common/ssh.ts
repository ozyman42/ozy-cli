import * as fs from 'node:fs/promises';
import { $ } from 'bun';
import SSHConfig, { LineType } from 'ssh-config';
import { Effect, Option } from 'effect';
import { log } from './log';
import { z } from 'zod';
import expandTilde from 'expand-tilde';
import { AGENT_SOCK_FILE_PATH } from './constants';

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
  DuplicateHostError = 'DuplicateHostError',
  EntryNotAHostKeyValuePairError = 'EntryNotAHostKeyValuePairError',
  MissingHostNameError = 'MissingHostNameError',
  MissingUserError = 'MissingUserError',
  MalformedError = 'MalformedError'
}

export function getSSHKeygenCommand() {
  return `ssh-keygen -o IdentityAgent=${AGENT_SOCK_FILE_PATH}`;
}

export function getSSHCommand(pubkeyPath: string) {
  return `ssh -i ${pubkeyPath} -o IdentitiesOnly=yes -o IdentityAgent=${AGENT_SOCK_FILE_PATH}`
}

export function getSSHConfig(sshConfigPathPartial = '~/.ssh/config'): Effect.Effect<SSHConfigHosts, string> {
  return Effect.gen(function* () {
    const sshConfigPath = expandTilde(sshConfigPathPartial);

    const sshFileExists = yield* Effect.promise(() => fs.exists(sshConfigPath));
    if (!sshFileExists)
      yield* Effect.fail(`${GetSSHConfigError.SSHConfigFileMissingError}: No file found at ${sshConfigPath}`);

    const sshFileContent = yield* Effect.tryPromise({
      try: () => fs.readFile(sshConfigPath),
      catch: (e) => `${GetSSHConfigError.ParseError}: unable to parse ssh file ${sshConfigPath}\n${e instanceof Error ? e.message : String(e)}`,
    });

    const sshFile = yield* Effect.try({
      try: () => SSHConfig.parse(sshFileContent.toString()),
      catch: (e) => `${GetSSHConfigError.ParseError}: unable to parse ssh file ${sshConfigPath}\n${e instanceof Error ? e.message : String(e)}`,
    });

    const hosts: SSHConfigHosts = {};
    for (const line of sshFile) {
      if (line.type === LineType.COMMENT) continue;
      const { param: curParam, value: host } = line;
      const valueStr = JSON.stringify(host);
      if (curParam !== 'Host')
        return yield* Effect.fail(`${GetSSHConfigError.EntryNotAHostKeyValuePairError}: Unexpected top-level entry in ssh file '${sshConfigPath}': ${curParam}=${valueStr}`);
      if (typeof host !== 'string')
        return yield* Effect.fail(`${GetSSHConfigError.EntryNotAHostKeyValuePairError}: top-level Host ${curParam} has value of non string '${valueStr}'`);
      if (!('config' in line))
        return yield* Effect.fail(`${GetSSHConfigError.EntryNotAHostKeyValuePairError}: top-level non-section detected in ssh file '${sshConfigPath}': ${curParam}=${valueStr}`);
      if (host in hosts)
        return yield* Effect.fail(`${GetSSHConfigError.DuplicateHostError}: ssh file '${sshConfigPath}' contains duplicate Hosts named '${host}'`);
      const keyValues: Record<string, string> = {};
      for (const innerLine of line.config) {
        if (innerLine.type === LineType.COMMENT) continue;
        const { param: innerParam, value: innerValue } = innerLine;
        if (typeof innerValue !== 'string')
          return yield* Effect.fail(`${GetSSHConfigError.MalformedError}: ssh file '${sshConfigPath}' at Host '${host}' at key '${innerParam}' has non string value '${innerValue}'`);
        keyValues[innerParam] = innerValue;
      }
      const result = SSHConfigSectionSchema.safeParse(keyValues);
      if (!result.success)
        return yield* Effect.fail(`${GetSSHConfigError.MalformedError}: malformed section at Host '${host}' due to ${result.error.toString()}`);
      hosts[host] = result.data;
    }

    return hosts;
  });
}

export async function getUsername(sshHost: string): Promise<Option.Option<string>> {
  try {
    const { stdout } = (await $`ssh -T ${sshHost} 2>&1`.nothrow().quiet());
    const output = stdout.toString().trim();
    if (output.startsWith('ssh: Could not resolve')) {
      log(output);
      return Option.none();
    } else if (output.startsWith('Hi ')) {
      const name = output.substring('Hi '.length).split('!')[0];
      return Option.some(name);
    } else {
      log('Unable to discern output ssh -T output format');
      log(output);
      return Option.none();
    }
  } catch (e) {
    const error = e as Error;
    log('unable to get username due to');
    log(error);
    return Option.none();
  }
}
