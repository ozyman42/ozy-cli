import { type EffectGen } from "effective-modules";

export interface ECDHKeyPair {
  base64Pubkey: string;
  keyPair: CryptoKeyPair;
}

export interface SSHKey {
  sshPublicKey: string;
  pemPrivateKey: string;
}

export interface DecryptInput {
  cipherText: string;
  iv: string;
  senderPubkey: string;
  receiverKey: CryptoKeyPair;
  hkdfInfo: string;
}

export interface ICrypto {
  getRandomChallenge(): EffectGen<string>;
  createECDHKey(): EffectGen<ECDHKeyPair, string>;
  decrypt(input: DecryptInput): EffectGen<Uint8Array, string>;
}