import { Effect } from "effect";
import { makeCommand } from "@/common/command";
import * as path from 'path';
import * as fs from 'fs';
import { log } from "@/common/log";
import { selectFromList } from "@ozyman42/interactive-cli-select";
import type { EffectGen } from "effective-modules";

const OPENSSH_MAGIC = Buffer.from('openssh-key-v1\0', 'utf8');

function isSkPublicKey(pubKeyPath: string): boolean {
  try {
    const keyType = fs.readFileSync(pubKeyPath, 'utf8').trim().split(/\s+/)[0] ?? '';
    return keyType.startsWith('sk-');
  } catch {
    return false;
  }
}

function parseCredentialId(privateKeyPath: string): string {
  const base64 = fs.readFileSync(privateKeyPath, 'utf8')
    .split('\n')
    .filter(line => !line.startsWith('-----'))
    .join('');
  const buf = Buffer.from(base64, 'base64');

  if (!buf.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
    throw new Error('Not an OpenSSH private key file.');
  }

  let off = OPENSSH_MAGIC.length;

  function readString(): Buffer {
    if (off + 4 > buf.length) throw new Error('Unexpected end of buffer.');
    const len = buf.readUInt32BE(off); off += 4;
    if (off + len > buf.length) throw new Error('Buffer underflow.');
    const chunk = buf.subarray(off, off + len); off += len;
    return chunk;
  }

  function readUint32(): number {
    if (off + 4 > buf.length) throw new Error('Unexpected end of buffer.');
    const val = buf.readUInt32BE(off); off += 4;
    return val;
  }

  const cipherName = readString().toString('utf8');
  if (cipherName !== 'none') throw new Error('Encrypted private keys are not supported.');
  readString(); // kdf name
  readString(); // kdf options

  if (readUint32() !== 1) throw new Error('Expected exactly 1 key.');
  readString(); // public key blob

  const pb = readString(); // private key block
  let p = 0;

  function pbString(): Buffer {
    if (p + 4 > pb.length) throw new Error('Unexpected end of private block.');
    const len = pb.readUInt32BE(p); p += 4;
    if (p + len > pb.length) throw new Error('Private block underflow.');
    const chunk = pb.subarray(p, p + len); p += len;
    return chunk;
  }

  const check1 = pb.readUInt32BE(p); p += 4;
  const check2 = pb.readUInt32BE(p); p += 4;
  if (check1 !== check2) throw new Error('Private key integrity check failed — key may be encrypted or corrupt.');

  const keyType = pbString().toString('utf8');
  if (keyType.includes('ecdsa')) {
    pbString(); // curve identifier
    pbString(); // ec_point
  } else if (keyType.includes('ed25519')) {
    pbString(); // public key (32 bytes)
  } else {
    throw new Error(`Unsupported security key type: ${keyType}`);
  }

  pbString(); // application string (e.g. 'ssh:')
  p += 1;     // flags byte

  return pbString().toString('hex');
}

export const skCredential = makeCommand('sk-credential', 'get credential id of a given ssh security key pointer', () =>
  Effect.gen(function* (): EffectGen<void, never> {
    // Effect v3 → v4 shim: Effect.async was renamed to Effect.callback
    (Effect as any).async = (Effect as any).callback;

    const cwd = process.cwd();
    const skKeys = fs.readdirSync(cwd).filter(name =>
      !name.endsWith('.pub') && isSkPublicKey(path.join(cwd, `${name}.pub`))
    );

    if (skKeys.length === 0) {
      log('No SSH security keys found.');
      return;
    }

    const choice = yield* selectFromList({
      options: skKeys,
      getKey: o => o,
      renderOption: o => o,
    }).pipe(Effect.orDie);

    const credentialId = parseCredentialId(path.join(cwd, choice));
    log(`Credential ID: ${credentialId}`);
  })
);
