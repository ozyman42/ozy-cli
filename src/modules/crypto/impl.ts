import { Effect, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { agentModules } from "../agent-modules";
import type { DecryptInput, ECDHKeyPair, ICrypto } from "./interface";
import bs58 from "bs58";

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}

export class CredentialId {
  public readonly base64: string;
  public readonly raw: Uint8Array;
  public static fromBase64(base64: string) {
    const base58 = bs58.encode(fromBase64url(base64));
    return new this(base58);
  }
  public constructor(public readonly base58: string) {
    this.raw = bs58.decode(base58);
    this.base64 = toBase64url(this.raw);
  }
}

export class CryptoImpl extends implementing(agentModules.Crypto) implements ICrypto {
  
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