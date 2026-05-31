import { Effect, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { commonModules } from "@/modules/common";
import type { DecryptInput, ECDHKeyPair, ICrypto } from "./interface";
import bs58 from "bs58";
import friendlyWords from "friendly-words";
import { sign as cryptoSign, createPrivateKey, createPublicKey } from "node:crypto";
import { FUTURE_TOOL_NAME } from "@/common/constants";

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function sshString(s: Buffer): Buffer {
  return Buffer.concat([u32(s.length), s]);
}

// PKCS#8 DER header for Ed25519
const PKCS8_ED25519_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

export class CredentialId {
  public readonly base64: string;
  public readonly raw: Uint8Array;
  public readonly humanReadableName: string;
  public static fromBase64(base64: string) {
    const base58 = bs58.encode(fromBase64url(base64));
    return new this(base58);
  }
  public constructor(public readonly base58: string) {
    this.raw = bs58.decode(base58);
    this.base64 = toBase64url(this.raw);
    // Extract three non-overlapping bit windows: 11 + 11 + 12 = 34 bits from bytes 0-4
    const b = this.raw;
    const adj1Idx = ((b[0]! << 3) | (b[1]! >> 5)) % friendlyWords.predicates.length;
    const adj2Idx = (((b[1]! & 0x1F) << 6) | (b[2]! >> 2)) % friendlyWords.predicates.length;
    const nounIdx = (((b[2]! & 0x3) << 10) | (b[3]! << 2) | (b[4]! >> 6)) % friendlyWords.objects.length;
    this.humanReadableName = [
      FUTURE_TOOL_NAME,
      friendlyWords.predicates[adj1Idx],
      friendlyWords.predicates[adj2Idx],
      friendlyWords.objects[nounIdx]
    ].join("-");
  }
}

export class SSHPubkey {
  readonly wire: Buffer;
  readonly keyType: string;
  readonly authorizedKey: string;

  private constructor(wire: Buffer) {
    this.wire = wire;
    const len = wire.readUInt32BE(0);
    this.keyType = wire.subarray(4, 4 + len).toString("utf8");
    this.authorizedKey = `${this.keyType} ${wire.toString("base64")}`;
  }

  static fromWire(wire: Buffer): SSHPubkey {
    return new SSHPubkey(wire);
  }

  static fromAuthorizedKey(s: string): SSHPubkey {
    return new SSHPubkey(Buffer.from(s.split(" ")[1]!, "base64"));
  }
}

export class SSHKeyPair {
  readonly pubkey: SSHPubkey;
  private readonly pemPrivateKey: string;

  private constructor(pubkey: SSHPubkey, pemPrivateKey: string) {
    this.pubkey = pubkey;
    this.pemPrivateKey = pemPrivateKey;
  }

  sign(data: Buffer): Buffer {
    return cryptoSign(null, data, createPrivateKey(this.pemPrivateKey));
  }

  static fromSeed(seed: Uint8Array, context: string): Effect.Effect<SSHKeyPair, string> {
    return Effect.tryPromise({
      try: async () => {
        const hkdfKey = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(context) } as any,
          hkdfKey,
          256
        );
        return SSHKeyPair.build(new Uint8Array(bits));
      },
      catch: (e) => String(e),
    });
  }

  private static build(seed: Uint8Array): SSHKeyPair {
    const der = Buffer.concat([PKCS8_ED25519_HEADER, Buffer.from(seed)]);
    const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const spki = createPublicKey(priv).export({ type: "spki", format: "der" }) as Buffer;
    const pubBytes = Buffer.from(spki.subarray(-32));

    const keyTypeBuf = Buffer.from("ssh-ed25519");
    const wire = Buffer.concat([sshString(keyTypeBuf), sshString(pubBytes)]);

    const pemPrivateKey = priv.export({ type: "pkcs8", format: "pem" }) as string;

    return new SSHKeyPair(SSHPubkey.fromWire(wire), pemPrivateKey);
  }
}

const { Crypto } = commonModules;

export class CryptoImpl extends implementing(Crypto) implements ICrypto {
  
  *getRandomChallenge(): EffectGen<string> {
    return toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  }
  
  *createECDHKey(): EffectGen<ECDHKeyPair, string> {
    const keyPair = yield* Effect.tryPromise({
      try: () => crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
      catch: (e) => (e as Error).toString(),
    });
    const agentPubKeyRaw = yield* Effect.tryPromise({
      try: () => crypto.subtle.exportKey("raw", keyPair.publicKey),
      catch: (e) => (e as Error).toString(),
    });
    const pubkey = toBase64url(new Uint8Array(agentPubKeyRaw));
    return {
      base64Pubkey: pubkey,
      keyPair,
    }
  }

  *decrypt({cipherText, iv, hkdfInfo, receiverKey, senderPubkey}: DecryptInput): EffectGen<Uint8Array, string> {
    return yield* pipe(
      Effect.tryPromise(async () => {
        const browserPubKey = await crypto.subtle.importKey(
          "raw", fromBase64url(senderPubkey),
          { name: "ECDH", namedCurve: "P-256" }, false, []
        );
        const sharedBits = await crypto.subtle.deriveBits(
          { name: "ECDH", public: browserPubKey }, receiverKey.privateKey, 256
        );
        const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
        const aesKey = await crypto.subtle.deriveKey(
          {
            name: "HKDF", hash: "SHA-256",
            salt: new Uint8Array(32),
            info: new TextEncoder().encode(hkdfInfo),
          },
          hkdfKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
        );
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64url(iv) },
          aesKey, fromBase64url(cipherText)
        );
        return new Uint8Array(decrypted);
      }),
      Effect.catchTag("UnknownError", err => Effect.fail(err.message))
    );
  }

}