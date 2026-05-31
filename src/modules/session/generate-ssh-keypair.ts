import { Effect } from "effect";
import type { EffectGen } from "effective-modules";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { SessionError } from "./interface";
import { log } from "../../common/log";
import type { SSHKey } from "../crypto/interface";

// PKCS#8 DER header for Ed25519: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING <32-byte seed> } }
const PKCS8_ED25519_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
}

function sshString(s: Buffer): Buffer {
  return Buffer.concat([u32(s.length), s]);
}

function seedToOpenSSHKeyPair(seed: Uint8Array): SSHKey {
  const der = Buffer.concat([PKCS8_ED25519_HEADER, Buffer.from(seed)]);
  const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  // SPKI DER for Ed25519 is 44 bytes; the last 32 bytes are the raw public key
  const spki = createPublicKey(priv).export({ type: "spki", format: "der" }) as Buffer;
  const pubBytes = Buffer.from(spki.subarray(-32));

  const keyType = Buffer.from("ssh-ed25519");
  const pubWire = Buffer.concat([sshString(keyType), sshString(pubBytes)]);
  const publicKey = `ssh-ed25519 ${pubWire.toString("base64")}`;

  // OpenSSH private key format ("none" cipher, unencrypted)
  // Private key blob for Ed25519: seed (32 bytes) || public key (32 bytes)
  const privBlob = Buffer.concat([Buffer.from(seed), pubBytes]);
  const checkInt = crypto.getRandomValues(new Uint8Array(4));
  const privEntry = Buffer.concat([
    checkInt, checkInt,                          // integrity check (same random value twice)
    sshString(keyType), sshString(pubBytes), sshString(privBlob),
    sshString(Buffer.alloc(0)),                  // comment (empty)
  ]);
  // Pad to multiple of 8 (cipher block size for "none")
  const padLen = (8 - (privEntry.length % 8)) % 8;
  const privBlock = Buffer.concat([
    privEntry,
    Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1)),
  ]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString(Buffer.from("none")),              // cipher
    sshString(Buffer.from("none")),              // kdf
    sshString(Buffer.alloc(0)),                  // kdf options
    u32(1),                                      // number of keys
    sshString(pubWire),
    sshString(privBlock),
  ]);
  const b64 = body.toString("base64");
  const lines = (b64.match(/.{1,70}/g) ?? []).join("\n");
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`;

  return { sshPublicKey: publicKey, pemPrivateKey: privateKey };
}

export function* getKey(seed: Uint8Array<ArrayBufferLike>, context: string): EffectGen<SSHKey, SessionError> {
  return yield* Effect.tryPromise({
    // TODO: hkdfKey derivation is repeated for each call to getKey; consider caching or passing it in
    try: async () => {
      const hkdfKey = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(context) } as any,
        hkdfKey,
        256
      );
      return seedToOpenSSHKeyPair(new Uint8Array(bits));
    },
    catch: (e) => {
      log(`Failed in deriving ssh key.`, e);
      return SessionError.InternalError({reason: (e as Error).toString()});
    },
  });
}
