/** SHA-256 helpers shared by manifests, receipts and artifacts. */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { MeshError } from '../errors.ts';
import { canonicalJson, type CanonicalValue } from './canonical-json.ts';

/**
 * Hash UTF-8 text.
 * @param text - input text.
 * @returns lower-case hex digest.
 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Hash raw bytes.
 * @param bytes - input bytes.
 * @returns lower-case hex digest.
 */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash a canonical JSON value.
 * @param value - JSON-safe value.
 * @returns lower-case hex digest.
 */
export function sha256Canonical(value: CanonicalValue): string {
  return sha256Text(canonicalJson(value));
}

/**
 * Stream a file through SHA-256.
 * @param path - absolute file path.
 * @returns lower-case hex digest.
 */
export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', error => {
      reject(new MeshError('ARTIFACT_INVALID', `cannot read file for hashing: ${path}`, {
        path,
        cause: error.message,
      }));
    });
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Validate a SHA-256 hex digest.
 * @param value - candidate digest.
 * @param field - label for the failure message.
 * @returns the unchanged digest.
 */
export function requireSha256(value: string, field: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new MeshError('INVALID_ARGUMENT', `${field} must be a lower-case SHA-256 hex digest`, { field });
  }
  return value;
}
