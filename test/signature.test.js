import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifySignature } from '../src/signature.js';

const secret = 'test-webhook-secret';

function sign(rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

test('verifies valid lowercase and uppercase hexadecimal signatures', () => {
  const rawBody = Buffer.from('{"event":"story-update"}');
  const signature = sign(rawBody);

  assert.equal(verifySignature(rawBody, signature, secret), true);
  assert.equal(verifySignature(rawBody, signature.toUpperCase(), secret), true);
});

test('verifies a Uint8Array body', () => {
  const rawBody = new Uint8Array(Buffer.from('{"event":"story-create"}'));

  assert.equal(verifySignature(rawBody, sign(rawBody), secret), true);
});

test('rejects missing and non-string signatures', () => {
  const rawBody = Buffer.from('{"event":"story-update"}');

  assert.equal(verifySignature(rawBody, undefined, secret), false);
  assert.equal(verifySignature(rawBody, null, secret), false);
  assert.equal(verifySignature(rawBody, Buffer.alloc(32), secret), false);
});

test('rejects malformed and wrong-length signatures', () => {
  const rawBody = Buffer.from('{"event":"story-update"}');
  const signature = sign(rawBody);

  assert.equal(verifySignature(rawBody, `sha256=${signature}`, secret), false);
  assert.equal(verifySignature(rawBody, `${signature.slice(0, -1)}g`, secret), false);
  assert.equal(verifySignature(rawBody, signature.slice(1), secret), false);
  assert.equal(verifySignature(rawBody, `${signature}0`, secret), false);
});

test('rejects an incorrect same-length signature', () => {
  const rawBody = Buffer.from('{"event":"story-update"}');
  const signature = sign(rawBody);
  const incorrectSignature = `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`;

  assert.equal(verifySignature(rawBody, incorrectSignature, secret), false);
});

test('signs exact bytes rather than semantically equivalent JSON', () => {
  const compactBody = Buffer.from('{"event":"story-update"}');
  const spacedBody = Buffer.from('{ "event": "story-update" }');
  const compactSignature = sign(compactBody);

  assert.equal(verifySignature(compactBody, compactSignature, secret), true);
  assert.equal(verifySignature(spacedBody, compactSignature, secret), false);
});
