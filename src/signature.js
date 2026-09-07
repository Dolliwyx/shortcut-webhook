import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_LENGTH = 64;
const HEX_SIGNATURE = /^[0-9a-fA-F]{64}$/u;

export function verifySignature(rawBody, providedSignature, secret) {
  if (
    !(Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array) ||
    typeof secret !== 'string' ||
    secret.length === 0 ||
    typeof providedSignature !== 'string' ||
    providedSignature.length !== SIGNATURE_LENGTH ||
    !HEX_SIGNATURE.test(providedSignature)
  ) {
    return false;
  }

  const expectedSignature = createHmac('sha256', secret)
    .update(rawBody)
    .digest();
  const receivedSignature = Buffer.from(providedSignature, 'hex');

  return (
    receivedSignature.length === expectedSignature.length &&
    timingSafeEqual(receivedSignature, expectedSignature)
  );
}
