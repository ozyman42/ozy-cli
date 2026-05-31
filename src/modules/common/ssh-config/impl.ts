import * as fs from "node:fs/promises";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import SSHConfig, { LineType } from "ssh-config";
import expandTilde from "expand-tilde";
import { implementing, type EffectGen } from "effective-modules";
import { commonModules } from "@/modules/common";

import { SSHConfigSection, type ISSHConfig, type SSHConfigHosts, type WriteHostInput, type WritePubkeyInput } from "./interface";

const SSH_CONFIG_PATH = "~/.ssh/config";
const SSH_DIR = "~/.ssh";

export class SSHConfigImpl extends implementing(commonModules.SSHConfig) implements ISSHConfig {
  private *loadSSHConfigRaw(): EffectGen<SSHConfig, string> {
    const configPath = expandTilde(SSH_CONFIG_PATH);
    const exists = yield* Effect.promise(() => fs.exists(configPath));
    const text = exists
      ? yield* Effect.tryPromise({
          try: () => fs.readFile(configPath, "utf8"),
          catch: (e) => `Failed to read ssh config at ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
        })
      : "";
    return yield* Effect.try({
      try: () => SSHConfig.parse(text),
      catch: (e) => `ParseError: unable to parse ssh config at ${configPath}\n${e instanceof Error ? e.message : String(e)}`,
    });
  }

  *getSSHConfig(): EffectGen<SSHConfigHosts, string> {
    const configPath = expandTilde(SSH_CONFIG_PATH);
    const exists = yield* Effect.promise(() => fs.exists(configPath));
    if (!exists)
      return yield* Effect.fail(`SSHConfigFileMissingError: No file found at ${configPath}`);

    const parsed = yield* this.loadSSHConfigRaw();

    const hosts: SSHConfigHosts = {};
    for (const line of parsed) {
      if (line.type === LineType.COMMENT) continue;
      const { param, value: host } = line;
      if (param !== "Host")
        return yield* Effect.fail(`EntryNotAHostKeyValuePairError: unexpected top-level entry '${param}=${JSON.stringify(host)}'`);
      if (typeof host !== "string")
        return yield* Effect.fail(`EntryNotAHostKeyValuePairError: Host value is not a string: ${JSON.stringify(host)}`);
      if (!("config" in line))
        return yield* Effect.fail(`EntryNotAHostKeyValuePairError: non-section Host entry '${host}'`);
      if (host in hosts)
        return yield* Effect.fail(`DuplicateHostError: duplicate Host '${host}' in ${configPath}`);

      const kv: Record<string, string> = {};
      for (const inner of line.config) {
        if (inner.type === LineType.COMMENT) continue;
        if (typeof inner.value !== "string")
          return yield* Effect.fail(`MalformedError: Host '${host}' key '${inner.param}' has non-string value`);
        kv[inner.param] = inner.value;
      }

      const section = yield* Schema.decodeUnknownEffect(SSHConfigSection)(kv).pipe(
        Effect.mapError(e => `MalformedError: malformed section at Host '${host}': ${String(e)}`)
      );
      hosts[host] = section;
    }

    return hosts;
  }

  *writeHost({ section }: WriteHostInput): EffectGen<void, string> {
    const configPath = expandTilde(SSH_CONFIG_PATH);
    const cfg = yield* this.loadSSHConfigRaw();
    const newEntries = Object.entries(section)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => ({ type: LineType.DIRECTIVE, before: '  ', param: k, separator: ' ', value: v as string, after: '\n' }));

    const existingIdx = cfg.findIndex((e: any) => e.param === "Host" && e.value === section.HostName);
    if (existingIdx >= 0) {
      (cfg[existingIdx] as any).config = newEntries;
    } else {
      const record: Record<string, string> = { Host: section.HostName };
      for (const [k, v] of Object.entries(section)) {
        if (v !== undefined) record[k] = v;
      }
      cfg.append(record);
    }

    yield* Effect.try({
      try: () => writeFileSync(configPath, SSHConfig.stringify(cfg), { mode: 0o600 }),
      catch: (e) => `Failed to write ssh config: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  *listPubkeyFiles(): EffectGen<{name: string, content: string}[], string> {
    const sshDir = expandTilde(SSH_DIR);
    const entries = yield* Effect.tryPromise({
      try: () => fs.readdir(sshDir),
      catch: (e) => `Failed to read ${sshDir}: ${e instanceof Error ? e.message : String(e)}`,
    });
    const pubkeyFiles = entries.filter(f => f.endsWith('.pub'));
    const results: {name: string, content: string}[] = [];
    for (const file of pubkeyFiles) {
      const content = yield* Effect.tryPromise({
        try: () => fs.readFile(join(sshDir, file), 'utf8'),
        catch: (e) => `Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`,
      });
      results.push({ name: file.slice(0, -'.pub'.length), content: content.trim() });
    }
    return results;
  }

  getPubkeyPath(name: string): string {
    return `${expandTilde(SSH_DIR)}/${name}.pub`;
  }

  *writePubkey({ name, comment, pubkey }: WritePubkeyInput): EffectGen<{pubkeyPath: string}, string> {
    const sshDir = expandTilde(SSH_DIR);
    const pubkeyPath = `${sshDir}/${name}.pub`;
    const content = Option.match(comment, {
      onNone: () => pubkey.authorizedKey,
      onSome: (c) => `${pubkey.authorizedKey} ${c}`,
    });

    yield* Effect.try({
      try: () => writeFileSync(pubkeyPath, content + "\n", { mode: 0o600 }),
      catch: (e) => `Failed to write pubkey to ${pubkeyPath}: ${e instanceof Error ? e.message : String(e)}`,
    });

    return {pubkeyPath};
  }
}
