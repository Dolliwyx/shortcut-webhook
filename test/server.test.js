import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { createServer, loadConfig } from '../index.js';
import { eventShape } from '../src/diagnostics.js';
import { lookupMemberNames } from '../src/members.js';
import { observedReferenceShapes } from './fixtures/observed-reference-shapes.js';
import { observedCommentCreate } from './fixtures/observed-comment-create.js';

const MAX_BODY_BYTES = 1024 * 1024;
const SECRET = 'server-test-secret';
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_MEMBER_ID = '22222222-2222-2222-2222-222222222222';
const DISCORD_USER_ID = '123456789012345678';

function validEnvironment(overrides = {}) {
  return {
    SHORTCUT_WEBHOOK_SECRET: SECRET,
    SHORTCUT_MEMBER_ID: MEMBER_ID,
    SHORTCUT_WORKSPACE_SLUG: 'example-workspace',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456/test-token',
    DISCORD_USER_ID,
    ...overrides,
  };
}

function localConfig(overrides = {}) {
  return {
    shortcutWebhookSecret: SECRET,
    shortcutMemberId: MEMBER_ID,
    workspaceSlug: 'example-workspace',
    discordWebhookUrl: 'http://127.0.0.1:1/fake-discord',
    discordUserId: DISCORD_USER_ID,
    ...overrides,
  };
}

function sign(rawBody) {
  return createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

function eligibleEvent() {
  return {
    id: 'event-eligible',
    changed_at: '2025-01-02T03:04:05.000Z',
    member_id: OTHER_MEMBER_ID,
    owner_ids: [MEMBER_ID],
    version: 'v1',
    actions: [
      {
        id: 42,
        entity_type: 'story',
        action: 'create',
        name: 'PRIVATE STORY TITLE',
        changes: {},
      },
    ],
    references: [],
  };
}

function ignoredEvent() {
  return {
    ...eligibleEvent(),
    id: 'event-ignored',
    member_id: MEMBER_ID,
  };
}

async function withServer(config, options, callback) {
  const server = createServer(config, options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function withFakeDiscord(callback) {
  const requests = [];
  const discord = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.statusCode = 200;
    response.end('{}');
  });

  discord.listen(0, '127.0.0.1');
  await once(discord, 'listening');
  const address = discord.address();
  const webhookUrl = `http://127.0.0.1:${address.port}/discord-webhook-token`;

  try {
    return await callback(webhookUrl, requests);
  } finally {
    await new Promise((resolve, reject) => {
      discord.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postWebhook(baseUrl, rawBody, signature = sign(rawBody)) {
  return fetch(`${baseUrl}/webhooks/shortcut`, {
    method: 'POST',
    headers: { 'Payload-Signature': signature },
    body: rawBody,
  });
}

function signedEvent(event) {
  return Buffer.from(JSON.stringify(event));
}

function parseMetadataLog(line) {
  const metadata = JSON.parse(line);
  for (const key of Object.keys(metadata)) {
    assert.ok(
      ['outcome', 'latencyMs', 'eventId', 'storyIds', 'actionTypes', 'discordStatus'].includes(key),
      `unexpected log key: ${key}`,
    );
  }
  return metadata;
}

test('loadConfig validates required values, strict Discord URLs, and PORT', () => {
  const config = loadConfig(validEnvironment());

  assert.deepEqual(config, {
    shortcutWebhookSecret: SECRET,
    shortcutApiToken: '',
    shortcutMemberId: MEMBER_ID,
    workspaceSlug: 'example-workspace',
    discordWebhookUrl: 'https://discord.com/api/webhooks/123456/test-token',
    discordUserId: DISCORD_USER_ID,
    port: 3000,
    diagnostics: false,
  });

  assert.equal(loadConfig(validEnvironment({ PORT: '65535' })).port, 65535);
  assert.equal(loadConfig(validEnvironment({ SHORTCUT_DIAGNOSTICS: '1' })).diagnostics, true);
  assert.equal(loadConfig(validEnvironment({ SHORTCUT_DIAGNOSTICS: 'true' })).diagnostics, false);

  assert.equal(loadConfig(validEnvironment({ SHORTCUT_API_TOKEN: 'test-api-token' })).shortcutApiToken, 'test-api-token');

  const invalidCases = [
    validEnvironment({ SHORTCUT_API_TOKEN: 'token\r\nInjected: header' }),
    validEnvironment({ SHORTCUT_API_TOKEN: '  ' }),
    validEnvironment({ SHORTCUT_API_TOKEN: 123 }),
    validEnvironment({ SHORTCUT_WEBHOOK_SECRET: '' }),
    validEnvironment({ SHORTCUT_MEMBER_ID: 'not-a-uuid' }),
    validEnvironment({ SHORTCUT_WORKSPACE_SLUG: 'two/segments' }),
    validEnvironment({ DISCORD_WEBHOOK_URL: 'http://discord.com/api/webhooks/123/token' }),
    validEnvironment({ DISCORD_WEBHOOK_URL: 'https://discord.com:443/api/webhooks/123/token' }),
    validEnvironment({ DISCORD_WEBHOOK_URL: 'https://user@discord.com/api/webhooks/123/token' }),
    validEnvironment({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/not-digits/token' }),
    validEnvironment({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/' }),
    validEnvironment({ DISCORD_USER_ID: 'not-digits' }),
    validEnvironment({ PORT: '0' }),
    validEnvironment({ PORT: '65536' }),
    validEnvironment({ PORT: '1.5' }),
  ];

  for (const env of invalidCases) {
    assert.throws(() => loadConfig(env), /Invalid configuration/u);
  }
});

test('routes health checks and rejects unsupported or unknown routes without upstream calls', async () => {
  let outboundCalls = 0;
  const options = {
    fetch: async () => {
      outboundCalls += 1;
      return { ok: true, status: 200 };
    },
    logger: () => {},
  };

  await withServer(localConfig(), options, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'OK');

    const wrongHealthMethod = await fetch(`${baseUrl}/healthz`, { method: 'POST' });
    assert.equal(wrongHealthMethod.status, 405);
    assert.equal(wrongHealthMethod.headers.get('allow'), 'GET');

    const wrongWebhookMethod = await fetch(`${baseUrl}/webhooks/shortcut`);
    assert.equal(wrongWebhookMethod.status, 405);
    assert.equal(wrongWebhookMethod.headers.get('allow'), 'POST');

    const unknown = await fetch(`${baseUrl}/not-a-route`, { method: 'POST' });
    assert.equal(unknown.status, 404);
  });

  assert.equal(outboundCalls, 0);
});

test('checks the signature before JSON parsing and distinguishes malformed JSON', async () => {
  const logs = [];

  await withServer(localConfig(), { fetch: async () => assert.fail('no delivery'), logger: logs.push.bind(logs) }, async (baseUrl) => {
    const malformed = Buffer.from('{ definitely not JSON }');

    const missingSignature = await fetch(`${baseUrl}/webhooks/shortcut`, {
      method: 'POST',
      body: malformed,
    });
    assert.equal(missingSignature.status, 401);

    const malformedSignature = await postWebhook(baseUrl, malformed, 'not-a-signature');
    assert.equal(malformedSignature.status, 401);

    const invalidSignature = await postWebhook(baseUrl, malformed, '0'.repeat(64));
    assert.equal(invalidSignature.status, 401);

    const validSignature = await postWebhook(baseUrl, malformed);
    assert.equal(validSignature.status, 400);

    const compact = Buffer.from('{"id":"same-json"}');
    const spaced = Buffer.from('{ "id": "same-json" }');
    const signatureForCompactBody = sign(compact);
    const whitespaceChanged = await postWebhook(baseUrl, spaced, signatureForCompactBody);
    assert.equal(whitespaceChanged.status, 401);
  });

  assert.equal(logs.length, 5);
});

test('accepts exactly one MiB but rejects an oversized webhook body', async () => {
  await withServer(localConfig(), { fetch: async () => assert.fail('no delivery'), logger: () => {} }, async (baseUrl) => {
    const prefix = '{"padding":"';
    const suffix = '"}';
    const exactlyOneMiB = Buffer.from(
      `${prefix}${'a'.repeat(MAX_BODY_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`,
    );
    assert.equal(exactlyOneMiB.length, MAX_BODY_BYTES);

    const atLimit = await postWebhook(baseUrl, exactlyOneMiB);
    assert.equal(atLimit.status, 400);

    const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);
    const overLimit = await postWebhook(baseUrl, oversized);
    assert.equal(overLimit.status, 413);
  });
});

test('returns 400 for invalid events and 204 without delivery for ignored events', async () => {
  let outboundCalls = 0;
  const options = {
    fetch: async () => {
      outboundCalls += 1;
      return { ok: true, status: 200 };
    },
    logger: () => {},
  };

  await withServer(localConfig(), options, async (baseUrl) => {
    const invalid = await postWebhook(baseUrl, signedEvent({}));
    assert.equal(invalid.status, 400);

    const ignored = await postWebhook(baseUrl, signedEvent(ignoredEvent()));
    assert.equal(ignored.status, 204);
  });

  assert.equal(outboundCalls, 0);
});

test('delivers one real HTTP JSON Discord request with wait=true', async () => {
  await withFakeDiscord(async (webhookUrl, requests) => {
    const logs = [];
    await withServer(
      localConfig({ discordWebhookUrl: webhookUrl }),
      { logger: logs.push.bind(logs) },
      async (baseUrl) => {
        const response = await postWebhook(baseUrl, signedEvent(eligibleEvent()));
        assert.equal(response.status, 204);
      },
    );

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url, webhookUrl).searchParams.get('wait'), 'true');
    assert.match(request.headers['content-type'], /^application\/json(?:;|$)/u);

    const payload = JSON.parse(request.body);
    assert.equal(payload.content, `<@${DISCORD_USER_ID}>`);
    assert.deepEqual(payload.allowed_mentions, { users: [DISCORD_USER_ID] });

    assert.equal(logs.length, 1);
    const log = parseMetadataLog(logs[0]);
    assert.equal(log.outcome, 'delivered');
    assert.equal(log.discordStatus, 200);
  });
});

test('maps Discord rejection and server errors to 502 without retrying', async () => {
  for (const status of [400, 500]) {
    let outboundCalls = 0;
    const logs = [];
    const webhookUrl = `http://127.0.0.1:1/discord-webhook-token-${status}`;
    const options = {
      fetch: async () => {
        outboundCalls += 1;
        return { ok: true, status };
      },
      logger: logs.push.bind(logs),
    };

    await withServer(localConfig({ discordWebhookUrl: webhookUrl }), options, async (baseUrl) => {
      const response = await postWebhook(baseUrl, signedEvent(eligibleEvent()));
      assert.equal(response.status, 502);
    });

    assert.equal(outboundCalls, 1);
    assert.equal(logs.length, 1);
    const log = parseMetadataLog(logs[0]);
    assert.equal(log.outcome, 'discord_failed');
    assert.equal(log.discordStatus, status);
    for (const privateValue of [
      webhookUrl,
      `discord-webhook-token-${status}`,
      SECRET,
      'PRIVATE STORY TITLE',
      'Story created',
      `<@${DISCORD_USER_ID}>`,
    ]) {
      assert.equal(logs[0].includes(privateValue), false);
    }
  }
});

test('maps a Discord timeout to 502 and aborts the only outbound request', async () => {
  let outboundCalls = 0;
  let aborts = 0;
  const options = {
    fetch: (_url, init) => {
      outboundCalls += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            aborts += 1;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    },
    logger: () => {},
    timeoutMs: 10,
  };

  await withServer(localConfig(), options, async (baseUrl) => {
    const response = await postWebhook(baseUrl, signedEvent(eligibleEvent()));
    assert.equal(response.status, 502);
  });

  assert.equal(outboundCalls, 1);
  assert.equal(aborts, 1);
});

test('opt-in diagnostics report shapes and validation paths only after signature and JSON checks', async () => {
  const invalid = {
    ...eligibleEvent(),
    references: [{ id: OTHER_MEMBER_ID, entity_type: 'member', name: 'PRIVATE MEMBER NAME' }],
    'PRIVATE KEY': { text: 'PRIVATE COMMENT', token: SECRET },
  };

  for (const diagnostics of [false, true]) {
    const logs = [];
    let outboundCalls = 0;
    await withServer(localConfig({ diagnostics }), {
      logger: (line) => logs.push(JSON.parse(line)),
      fetch: async () => { outboundCalls += 1; return { status: 200 }; },
    }, async (baseUrl) => {
      assert.equal((await postWebhook(baseUrl, signedEvent(invalid), '0'.repeat(64))).status, 401);
      assert.equal((await postWebhook(baseUrl, Buffer.from('{'))).status, 400);
      assert.equal(logs.filter((line) => line.outcome === 'diagnostic').length, 0);
      assert.equal((await postWebhook(baseUrl, signedEvent(invalid))).status, 400);
      assert.equal((await postWebhook(baseUrl, signedEvent(ignoredEvent()))).status, 204);
      assert.equal((await postWebhook(baseUrl, signedEvent(eligibleEvent()))).status, 204);
    });
    assert.equal(outboundCalls, 1);
    const diagnosticLogs = logs.filter((line) => line.outcome === 'diagnostic');
    assert.equal(diagnosticLogs.length, diagnostics ? 3 : 0);
    for (const line of logs.filter((line) => line.outcome !== 'diagnostic')) {
      parseMetadataLog(JSON.stringify(line));
    }
    if (!diagnostics) continue;

    const [rejected, ignored, accepted] = diagnosticLogs;
    assert.deepEqual(rejected.validationError, {
      path: '$.references[0].id', expected: 'positive safe integer', actual: 'string',
    });
    assert.equal(rejected.eventOutcome, 'invalid');
    assert.equal(ignored.eventOutcome, 'ignored');
    assert.equal(accepted.eventOutcome, 'deliver');
    assert.equal(accepted.validationError, undefined);
    assert.deepEqual(ignored.memberChecks, { selfAuthored: true, aggregateOwnerMatch: true });
    assert.deepEqual(accepted.memberChecks, { selfAuthored: false, aggregateOwnerMatch: true });
    assert.ok(rejected.shape.fields.some((field) => field.path === '$.references[0].id' && field.type === 'string'));
    assert.ok(rejected.shape.fields.some((field) => field.path.includes('redacted-key-')));
    assert.equal(rejected.shape.truncated, false);
    for (const value of [SECRET, MEMBER_ID, OTHER_MEMBER_ID, DISCORD_USER_ID,
      'PRIVATE STORY TITLE', 'PRIVATE MEMBER NAME', 'PRIVATE KEY', 'PRIVATE COMMENT',
      'event-eligible', '2025-01-02T03:04:05.000Z']) {
      assert.equal(JSON.stringify(diagnosticLogs).includes(value), false, value);
    }
  }
});

test('diagnostic shapes are bounded and mark omitted fields without exposing keys or values', () => {
  const samples = [
    { actions: Array.from({ length: 11 }, (_, id) => ({ id })) },
    Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`PRIVATE KEY ${index}`, 'PRIVATE VALUE'])),
    Array.from({ length: 20 }).reduce((value) => ({ story: value }), { text: 'PRIVATE VALUE' }),
  ];
  for (const sample of samples) {
    const shape = eventShape(sample);
    assert.equal(shape.truncated, true);
    assert.ok(shape.fields.length <= 200);
    assert.equal(JSON.stringify(shape).includes('PRIVATE'), false);
  }
  assert.deepEqual(eventShape({ text: null, changes: [], estimate: 42, story: true }), {
    fields: [
      { path: '$', type: 'object' },
      { path: '$.text', type: 'null' },
      { path: '$.changes', type: 'array' },
      { path: '$.estimate', type: 'number' },
      { path: '$.story', type: 'boolean' },
    ],
    truncated: false,
  });
});

test('signed events with observed optional reference shapes reach Discord', async () => {
  await withFakeDiscord(async (webhookUrl, requests) => {
    const logs = [];
    await withServer(localConfig({ discordWebhookUrl: webhookUrl, diagnostics: true }), {
      logger: (line) => logs.push(JSON.parse(line)),
    }, async (baseUrl) => {
      for (const shape of observedReferenceShapes) {
        const event = eligibleEvent();
        delete event.references;
        Object.assign(event, shape);
        assert.equal((await postWebhook(baseUrl, signedEvent(event))).status, 204);
      }
    });
    assert.equal(requests.length, observedReferenceShapes.length);
    assert.equal(logs.filter((line) => line.outcome === 'delivered').length, observedReferenceShapes.length);
    for (const line of logs.filter((line) => line.outcome === 'diagnostic')) {
      assert.equal(line.eventOutcome, 'deliver');
      assert.equal(line.validationError, undefined);
    }
  });
});

test('comment diagnostics expose fixed labels and numeric relationships, not private values', async () => {
  // Synthetic candidate association for testing diagnostics only; not a captured event.
  const event = {
    ...eligibleEvent(),
    owner_ids: [],
    actions: [
      { id: 975312468, entity_type: 'story-comment', action: 'create', text: 'PRIVATE COMMENT' },
      { id: 864213579, entity_type: 'story', action: 'update', changes: {
        comment_ids: { adds: [975312468] },
        'PRIVATE KEY': { new: 'PRIVATE VALUE' },
      } },
      { id: 753124689, entity_type: 'PRIVATE ENTITY', action: 'PRIVATE OPERATION' },
    ],
  };
  const logs = [];
  await withServer(localConfig({ diagnostics: true }), {
    logger: (line) => logs.push(JSON.parse(line)),
    fetch: () => assert.fail('diagnostics must not change filtering'),
  }, async (baseUrl) => {
    assert.equal((await postWebhook(baseUrl, signedEvent(event))).status, 204);
  });
  const diagnostic = logs.find((line) => line.outcome === 'diagnostic');
  assert.deepEqual(diagnostic.memberChecks, { selfAuthored: false, aggregateOwnerMatch: false });
  const fields = diagnostic.shape.fields;
  assert.equal(fields.find((field) => field.path === '$.actions[0].entity_type').knownValue, 'story-comment');
  assert.equal(fields.find((field) => field.path === '$.actions[0].action').knownValue, 'create');
  assert.equal(fields.find((field) => field.path === '$.actions[2].entity_type').knownValue, 'unrecognized');
  assert.equal(fields.find((field) => field.path === '$.actions[2].action').knownValue, 'unrecognized');
  assert.equal(fields.find((field) => field.path === '$.actions[1].changes.comment_ids.adds[0]').sameNumberAs, '$.actions[0].id');
  for (const value of ['PRIVATE', '975312468', '864213579', '753124689', MEMBER_ID, OTHER_MEMBER_ID]) {
    assert.equal(JSON.stringify(diagnostic).includes(value), false, value);
  }
  assert.equal(logs.at(-1).outcome, 'ignored');
});

test('confirmed comment shape sends one bounded Discord message without logging text', async () => {
  await withFakeDiscord(async (webhookUrl, requests) => {
    const event = observedCommentCreate();
    event.member_id = OTHER_MEMBER_ID;
    event.owner_ids = [MEMBER_ID];
    const logs = [];
    await withServer(localConfig({ discordWebhookUrl: webhookUrl, diagnostics: true }), {
      logger: (line) => logs.push(line),
    }, async (baseUrl) => {
      assert.equal((await postWebhook(baseUrl, signedEvent(event))).status, 204);
    });
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.embeds[0].description, 'Comment added\n> Example comment text');
    assert.match(payload.embeds[0].url, /\/story\/501$/);
    assert.equal(payload.content, `<@${DISCORD_USER_ID}>`);
    assert.deepEqual(payload.allowed_mentions, { users: [DISCORD_USER_ID] });
    assert.equal(JSON.parse(logs.at(-1)).outcome, 'delivered');
    assert.equal(logs.join('\n').includes('Example comment'), false);
    assert.equal(logs.join('\n').includes('Example Story'), false);
  });
});

test('looks up the eligible comment author and includes their name only in the Discord embed', async () => {
  const event = observedCommentCreate();
  event.member_id = OTHER_MEMBER_ID;
  event.owner_ids = [MEMBER_ID];
  const authorId = event.actions[0].author_id;
  assert.notEqual(authorId, event.member_id);
  const logs = [];
  const requests = [];
  await withServer(localConfig({ shortcutApiToken: 'PRIVATE API TOKEN', diagnostics: true }), {
    logger: (line) => logs.push(line),
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.startsWith('https://api.app.shortcut.com/')) {
        assert.equal(url, `https://api.app.shortcut.com/api/v3/members/${authorId}`);
        assert.equal(init.method, 'GET');
        assert.equal(init.headers['Shortcut-Token'], 'PRIVATE API TOKEN');
        assert.equal(init.redirect, 'error');
        return Response.json({ id: authorId, profile: { name: '  Alice\nExample  ' } });
      }
      assert.equal(init.headers['Shortcut-Token'], undefined);
      return { status: 200 };
    },
  }, async (baseUrl) => {
    assert.equal((await postWebhook(baseUrl, signedEvent(event))).status, 204);
  });
  assert.equal(requests.length, 2);
  const payload = JSON.parse(requests[1].init.body);
  assert.equal(payload.embeds[0].description, '**Alice Example** commented\n> Example comment text');
  assert.equal(payload.content, `<@${DISCORD_USER_ID}>`);
  assert.deepEqual(payload.allowed_mentions, { users: [DISCORD_USER_ID] });
  for (const value of ['PRIVATE API TOKEN', 'Alice', 'Example comment text', authorId]) {
    assert.equal(logs.join('\n').includes(value), false, value);
  }
});

test('does not look up unsigned, invalid, ignored, unassociated, or non-comment events', async () => {
  let lookups = 0;
  let deliveries = 0;
  const comment = observedCommentCreate();
  comment.owner_ids = [MEMBER_ID];
  await withServer(localConfig({ shortcutApiToken: 'test-token' }), {
    logger: () => {},
    fetch: async (url) => {
      if (url.startsWith('https://api.app.shortcut.com/')) lookups += 1;
      else deliveries += 1;
      return { status: 200 };
    },
  }, async (baseUrl) => {
    assert.equal((await postWebhook(baseUrl, signedEvent(comment), '0'.repeat(64))).status, 401);
    assert.equal((await postWebhook(baseUrl, signedEvent({}))).status, 400);
    assert.equal((await postWebhook(baseUrl, signedEvent({ ...comment, member_id: MEMBER_ID }))).status, 204);
    assert.equal((await postWebhook(baseUrl, signedEvent({ ...comment, owner_ids: [] }))).status, 204);
    const unassociated = structuredClone(comment);
    delete unassociated.actions[1].changes.comment_ids;
    assert.equal((await postWebhook(baseUrl, signedEvent(unassociated))).status, 204);
    assert.equal((await postWebhook(baseUrl, signedEvent(eligibleEvent()))).status, 204);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  });
  assert.equal(lookups, 0);
  assert.equal(deliveries, 1);
});

test('member lookup failures and timeouts never prevent comment delivery', async () => {
  const event = observedCommentCreate();
  event.owner_ids = [MEMBER_ID];
  const responses = [
    async () => new Response('', { status: 401 }),
    async () => new Response('', { status: 404 }),
    async () => new Response('', { status: 429 }),
    async () => new Response('', { status: 500 }),
    async () => { throw new Error('PRIVATE API ERROR'); },
    async () => new Response('not json'),
    async () => Response.json({ id: event.actions[0].author_id, profile: {} }),
    async () => Response.json({ id: MEMBER_ID, profile: { name: 'Wrong member' } }),
    async () => new Promise(() => {}),
    async () => ({ ok: true, json: () => new Promise(() => {}) }),
  ];
  for (const respond of responses) {
    let lookups = 0;
    const payloads = [];
    let signal;
    await withServer(localConfig({ shortcutApiToken: 'test-token' }), {
      logger: () => {},
      memberTimeoutMs: 10,
      fetch: async (url, init) => {
        if (url.startsWith('https://api.app.shortcut.com/')) {
          lookups += 1;
          signal = init.signal;
          return respond();
        }
        payloads.push(JSON.parse(init.body));
        return { status: 200 };
      },
    }, async (baseUrl) => {
      assert.equal((await postWebhook(baseUrl, signedEvent(event))).status, 204);
    });
    assert.equal(lookups, 1);
    assert.equal(signal.aborted, true);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].embeds[0].description, 'Comment added\n> Example comment text');
  }
});

test('member lookup validates UUIDs, deduplicates requests, caps work and uses username fallback', async () => {
  const calls = [];
  const ids = Array.from({ length: 12 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  const names = await lookupMemberNames([ids[0], ...ids, '../member', 'https://evil.example/', null], 'test-token', async (url) => {
    calls.push(url);
    const id = url.split('/').at(-1);
    return Response.json({ id, profile: { name: null, mention_name: 'username' } });
  });
  assert.equal(calls.length, 10);
  assert.equal(names.size, 10);
  assert.equal(names.get(ids[0]), 'username');
  assert.ok(calls.every((url) => url.startsWith('https://api.app.shortcut.com/api/v3/members/')));
  assert.equal((await lookupMemberNames(ids, '', () => assert.fail('no token'))).size, 0);
  assert.equal((await lookupMemberNames(['../member'], 'token', () => assert.fail('invalid UUID'))).size, 0);
});
