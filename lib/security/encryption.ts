import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

function getEncryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error("Missing TOKEN_ENCRYPTION_KEY env var.");
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (hex-64 or base64-32-byte).");
  }

  return decoded;
}

export function encryptSecret(plaintext: string) {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

export function decryptSecret(ciphertextEnvelope: string) {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = ciphertextEnvelope.split(".");

  if (version !== VERSION || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error("Invalid encrypted token format.");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(ivEncoded, "base64url");
  const authTag = Buffer.from(tagEncoded, "base64url");
  const ciphertext = Buffer.from(ciphertextEncoded, "base64url");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
