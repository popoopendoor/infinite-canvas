import {
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";

const keyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function encryptionPublicKey() {
  return keyPair.publicKey;
}

export function decryptSecret(value: string) {
  const encrypted = Buffer.from(value, "base64url");
  return privateDecrypt(
    { key: keyPair.privateKey, oaepHash: "sha256" },
    encrypted,
  ).toString("utf8");
}
