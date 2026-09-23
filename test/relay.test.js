import assert from 'node:assert/strict';
import test from 'node:test';

import { processEvent } from '../src/relay.js';
import { observedReferenceShapes } from './fixtures/observed-reference-shapes.js';
import { observedCommentCreate } from './fixtures/observed-comment-create.js';
import {
  DISCORD_USER_ID,
  OTHER_MEMBER_ID,
  TARGET_MEMBER_ID,
  commentAction,
  ownerIdsChange,
  scalarChange,
  storyAction,
  syntheticEvent,
  workflowReference,
} from './fixtures/synthetic-v1-events.js';

const relayOptions = Object.freeze({
  shortcutMemberId: TARGET_MEMBER_ID,
  workspaceSlug: 'synthetic-workspace',
  discordUserId: DISCORD_USER_ID,
});

function deliver(event) {
  const result = processEvent(event, relayOptions);
  assert.equal(result.outcome, 'deliver');
  return result;
}

function messageText(result) {
  return result.payload.content.replace(/^<@\d+> [^\n]*\n(?:Changed: [^\n]+\n)?\n/u, '');
}

function messageSummary(result) {
  return messageText(result).split('\n').slice(1).join('\n');
}

test('rejects malformed v1 envelopes before self-action filtering', () => {
  const invalidEvents = [
    null,
    syntheticEvent({ id: 12 }),
    syntheticEvent({ changedAt: 12 }),
    syntheticEvent({ memberId: '' }),
    syntheticEvent({ version: 'v2' }),
    syntheticEvent({ actions: {} }),
    syntheticEvent({ actions: [null] }),
    syntheticEvent({ references: null }),
    syntheticEvent({ references: {} }),
    syntheticEvent({ references: [workflowReference(9, null)] }),
    syntheticEvent({ references: [workflowReference(9, '')] }),
    syntheticEvent({ references: [workflowReference(9, 123)] }),
    syntheticEvent({ references: [workflowReference('9', 'Wrong ID type')] }),
    syntheticEvent({ memberId: TARGET_MEMBER_ID, references: {} }),
  ];

  for (const event of invalidEvents) {
    assert.deepEqual(processEvent(event, relayOptions), {
      outcome: 'invalid',
      storyIds: [],
      actionTypes: [],
    });
  }
});

test('rejects malformed action records and optional fields before self-suppression', () => {
  const validAction = { id: 51, entity_type: 'unsupported-entity', action: 'unsupported-action' };
  const malformedActions = [
    {},
    { ...validAction, id: 0 },
    { ...validAction, id: '51' },
    { ...validAction, entity_type: '' },
    { ...validAction, action: '  ' },
    { ...validAction, name: 51 },
    { ...validAction, changes: [] },
    { ...validAction, changes: null },
    { ...validAction, owner_ids: 'not-an-array' },
    { ...validAction, owner_ids: [TARGET_MEMBER_ID, ''] },
    { ...validAction, story_id: 0 },
    { ...validAction, story_id: '51' },
  ];

  for (const action of malformedActions) {
    assert.deepEqual(processEvent(syntheticEvent({ actions: [action] }), relayOptions), {
      outcome: 'invalid',
      storyIds: [],
      actionTypes: [],
    });
  }

  for (const ownerIds of ['not-an-array', [TARGET_MEMBER_ID, '']]) {
    assert.deepEqual(processEvent(syntheticEvent({ actions: [validAction], ownerIds }), relayOptions), {
      outcome: 'invalid',
      storyIds: [],
      actionTypes: [],
    });
  }

  const malformedSelfAction = syntheticEvent({
    memberId: TARGET_MEMBER_ID,
    actions: [{ ...validAction, changes: [] }],
  });
  assert.deepEqual(processEvent(malformedSelfAction, relayOptions), {
    outcome: 'invalid',
    storyIds: [],
    actionTypes: [],
  });
});

test('ignores unsupported but well-formed entity and action values', () => {
  const event = syntheticEvent({
    ownerIds: [TARGET_MEMBER_ID],
    actions: [
      {
        id: 52,
        entity_type: 'unsupported-entity',
        action: 'unsupported-action',
        name: 'Well formed but unsupported',
        changes: {},
        owner_ids: [],
        story_id: 99,
      },
    ],
  });

  assert.equal(processEvent(event, relayOptions).outcome, 'ignored');
});

test('suppresses a well-formed event authored by the configured member', () => {
  const event = syntheticEvent({
    id: '00000000-0000-4000-8000-000000000002',
    memberId: TARGET_MEMBER_ID,
    ownerIds: [TARGET_MEMBER_ID],
    actions: [
      storyAction(42, 'update', {
        name: 'Do not relay this',
        changes: { workflow_state_id: scalarChange(1, 2) },
      }),
    ],
  });

  assert.deepEqual(processEvent(event, relayOptions), {
    outcome: 'ignored',
    storyIds: [],
    actionTypes: [],
    eventId: event.id,
  });
});

test('ignores Epic, task, deletion, and unrelated-field actions', () => {
  const event = syntheticEvent({
    ownerIds: [TARGET_MEMBER_ID],
    actions: [
      { id: 1, entity_type: 'epic', action: 'create' },
      storyAction(2, 'delete', { name: 'Deleted Story' }),
      commentAction(3, 'delete', 2, { changes: { text: { new: 'Deleted comment' } } }),
      { id: 4, entity_type: 'task', action: 'update', story_id: 4 },
      storyAction(5, 'update', {
        name: 'Only unrelated fields',
        changes: { description: scalarChange('before', 'after') },
      }),
    ],
  });

  assert.equal(processEvent(event, relayOptions).outcome, 'ignored');
});

test('excludes deletions before deciding whether aggregate ownership has one Story', () => {
  const result = deliver(
    syntheticEvent({
      ownerIds: [TARGET_MEMBER_ID],
      actions: [
        storyAction(20, 'delete', { name: 'Ignored deletion' }),
        commentAction(201, 'delete', 20, { changes: { text: { new: 'Ignored deletion' } } }),
        storyAction(21, 'update', {
          name: 'Only remaining Story',
          changes: { workflow_state_id: scalarChange(1, 2) },
        }),
      ],
    }),
  );

  assert.deepEqual(result.storyIds, [21]);
});

test('formats one current-owned Story with reference names, allowed fields, and a safe mention', () => {
  const event = syntheticEvent({
    ownerIds: [TARGET_MEMBER_ID],
    actions: [
      storyAction(101, 'update', {
        name: 'Deploy release',
        changes: {
          workflow_state_id: scalarChange(1, 2),
          deadline: scalarChange('2025-01-01', '2025-02-03'),
          estimate: scalarChange(2, 5),
          description: scalarChange('private old text', 'private new text'),
        },
      }),
    ],
    references: [workflowReference(2, 'Ready for Deploy')],
  });

  // No primary_id is needed to identify a Story.
  assert.equal(Object.hasOwn(event, 'primary_id'), false);

  const result = deliver(event);
  assert.deepEqual(result.storyIds, [101]);
  assert.deepEqual(result.actionTypes, ['story.update']);
  assert.deepEqual(Object.keys(result.payload).sort(), ['allowed_mentions', 'content']);
  assert.match(result.payload.content, new RegExp(`^<@${DISCORD_USER_ID}> Workflow: Ready for Deploy.*\\nChanged: ${event.changed_at}\\n\\n`));
  assert.deepEqual(result.payload.allowed_mentions, { users: [DISCORD_USER_ID] });
  assert.ok(messageText(result).startsWith('[Deploy release \\(\\#101\\)](https://app.shortcut.com/synthetic-workspace/story/101)'));
  assert.equal(
    messageSummary(result),
    ['Workflow: Ready for Deploy', 'Deadline: 2025-02-03', 'Estimate: 5'].join('\n'),
  );
  assert.doesNotMatch(result.payload.content, /private new text/);
});

test('falls back to a workflow ID when its reference is absent', () => {
  const result = deliver(
    syntheticEvent({
      ownerIds: [TARGET_MEMBER_ID],
      actions: [
        storyAction(102, 'update', {
          name: 'Missing workflow reference',
          changes: { workflow_state_id: scalarChange(1, 99) },
        }),
      ],
    }),
  );

  assert.match(messageSummary(result), /Workflow: 99/);
});

test('delivers a created Story owned through its direct synthetic owner_ids shape', () => {
  const result = deliver(
    syntheticEvent({
      actions: [
        storyAction(301, 'create', {
          name: 'Newly owned',
          ownerIds: [TARGET_MEMBER_ID],
        }),
      ],
    }),
  );

  assert.equal(messageSummary(result), 'Story created');
  assert.deepEqual(result.storyIds, [301]);
  assert.deepEqual(result.actionTypes, ['story.create']);
});

test('includes safe plain-text descriptions, Shortcut members, links, and a single allowed mention', () => {
  const description = '**Details**\n\n- First item\n- Notify @everyone <@987654321> [@Jane](shortcutapp://members/member-id) and [docs](https://example.com)';
  const result = deliver(syntheticEvent({
    actions: [storyAction(301, 'create', { ownerIds: [TARGET_MEMBER_ID], description })],
  }));
  const content = result.payload.content;
  assert.match(messageSummary(result), /\\\*\\\*Details\\\*\\\*/u);
  assert.match(messageSummary(result), /@\u200beveryone/u);
  assert.match(messageSummary(result), /\*\*@Jane\*\*/u);
  assert.match(content.split('\n')[0], /Story created.*Details.*First item.*@\u200beveryone.*\*\*@Jane\*\*/u);
  assert.match(messageSummary(result), /\\\[docs\\\]\\\(https:\u200b\/\/example\.com\\\)/u);
  assert.doesNotMatch(content, /<@987654321>/u);
  assert.deepEqual(result.payload.allowed_mentions, { users: [DISCORD_USER_ID] });
  assert.deepEqual(Object.keys(result.payload).sort(), ['allowed_mentions', 'content']);
});

test('escapes parentheses in the generated Story URL for plain-text links', () => {
  const event = syntheticEvent({
    actions: [storyAction(301, 'create', { ownerIds: [TARGET_MEMBER_ID] })],
  });
  const result = processEvent(event, { ...relayOptions, workspaceSlug: 'team(test)' });
  assert.match(result.payload.content, /\]\(https:\/\/app\.shortcut\.com\/team%28test%29\/story\/301\)/u);
});

test('omits unavailable descriptions and bounds long summaries within Discord content limit', () => {
  for (const description of [undefined, null, 12, {}, '', '  \n  ']) {
    const result = deliver(syntheticEvent({
      actions: [storyAction(301, 'create', { ownerIds: [TARGET_MEMBER_ID], description })],
    }));
    assert.equal(messageSummary(result), 'Story created');
  }
  for (const count of [1, 10]) {
    const result = deliver(syntheticEvent({
      actions: Array.from({ length: count }, (_, index) => storyAction(301 + index, 'create', {
        ownerIds: [TARGET_MEMBER_ID],
        description: 'Details\n'.repeat(1000),
      })),
    }));
    assert.ok(result.payload.content.length <= 2000);
    assert.match(messageSummary(result), /^Story created\n\nDetails\n/u);
    assert.match(result.payload.content, /additional changes omitted/u);
    if (count === 10) assert.match(result.payload.content, /9 more stories omitted/u);
  }
});

test('delivers ownership addition and removal without aggregate ownership', () => {
  for (const [change, expectedSummary] of [
    [ownerIdsChange({ adds: [TARGET_MEMBER_ID] }), 'You were added as an owner'],
    [ownerIdsChange({ removes: [TARGET_MEMBER_ID] }), 'You were removed as an owner'],
  ]) {
    const result = deliver(
      syntheticEvent({
        actions: [
          storyAction(302, 'update', {
            name: 'Ownership changed',
            changes: { owner_ids: change },
          }),
        ],
      }),
    );

    assert.equal(messageSummary(result), expectedSummary);
  }
});

test('ignores an unowned eligible change and an owned update outside the field allowlist', () => {
  const unowned = syntheticEvent({
    ownerIds: [OTHER_MEMBER_ID],
    actions: [
      storyAction(401, 'update', {
        name: 'Someone else owns this',
        changes: { workflow_state_id: scalarChange(1, 2) },
      }),
    ],
  });
  const onlyUnrelated = syntheticEvent({
    ownerIds: [TARGET_MEMBER_ID],
    actions: [
      storyAction(402, 'update', {
        name: 'Only description changed',
        changes: {
          description: scalarChange('old', 'new'),
          labels: scalarChange('old labels', 'new labels'),
        },
      }),
    ],
  });

  assert.equal(processEvent(unowned, relayOptions).outcome, 'ignored');
  assert.equal(processEvent(onlyUnrelated, relayOptions).outcome, 'ignored');
});

test('associates synthetic comments only by direct story_id and normalizes excerpts', () => {
  const result = deliver(
    syntheticEvent({
      ownerIds: [TARGET_MEMBER_ID],
      actions: [
        commentAction(5011, 'create', 501, { changes: { text: { new: '  First\t[@Jane](shortcutapp://members/member-id)\nline  ' } } }),
        commentAction(5012, 'update', 501, { changes: { text: { new: 'Second comment' } } }),
      ],
    }),
  );

  assert.ok(messageText(result).startsWith('[Story \\#501](https://app.shortcut.com/synthetic-workspace/story/501)'));
  assert.equal(messageSummary(result), 'Comment added\n> First **@Jane** line\n\nComment updated\n> Second comment');
  assert.deepEqual(result.actionTypes, ['comment.create', 'comment.update']);
});

test('truncates comment excerpts to 200 characters and still sends missing text without an excerpt', () => {
  const longComment = `\n ${'x'.repeat(210)} \t`;
  const longResult = deliver(
    syntheticEvent({
      ownerIds: [TARGET_MEMBER_ID],
      actions: [commentAction(5021, 'create', 502, { changes: { text: { new: longComment } } })],
    }),
  );
  const longDescription = messageSummary(longResult);
  const excerpt = longDescription.slice('Comment added\n> '.length);
  assert.ok(excerpt.length <= 200);
  assert.ok(excerpt.endsWith('…'));
  assert.doesNotMatch(excerpt, /\s{2,}|\n/);

  const noTextResult = deliver(
    syntheticEvent({
      ownerIds: [TARGET_MEMBER_ID],
      actions: [commentAction(5031, 'update', 503, { changes: { body: { new: 'Unsupported text location' } } })],
    }),
  );
  assert.equal(messageSummary(noTextResult), 'Comment updated');
});

test('ignores missing comment associations, does not infer primary_id, and rejects malformed story_id', () => {
  const noDirectStoryId = syntheticEvent({
    primary_id: 801,
    ownerIds: [TARGET_MEMBER_ID],
    actions: [
      {
        id: 8011,
        entity_type: 'comment',
        action: 'create',
        changes: { text: { new: 'Do not infer from primary_id' } },
      },
    ],
  });
  const stringStoryId = syntheticEvent({
    ownerIds: [TARGET_MEMBER_ID],
    actions: [commentAction(8021, 'create', '802', { changes: { text: { new: 'Do not coerce IDs' } } })],
  });

  assert.equal(processEvent(noDirectStoryId, relayOptions).outcome, 'ignored');
  assert.equal(processEvent(stringStoryId, relayOptions).outcome, 'invalid');
});

test('orders multiple eligible Story groups by first eligible action and preserves per-group action order', () => {
  const result = deliver(
    syntheticEvent({
      actions: [
        storyAction(602, 'update', {
          name: 'Second in numeric order',
          changes: { owner_ids: ownerIdsChange({ adds: [TARGET_MEMBER_ID] }) },
        }),
        storyAction(601, 'create', { name: 'First in numeric order', ownerIds: [TARGET_MEMBER_ID] }),
        commentAction(6021, 'create', 602, { changes: { text: { new: 'Comment after ownership' } } }),
      ],
    }),
  );

  assert.deepEqual(result.storyIds, [602, 601]);
  assert.deepEqual(result.actionTypes, ['story.update', 'story.create', 'comment.create']);

  const content = messageText(result);
  assert.ok(content.indexOf('Second in numeric order') < content.indexOf('First in numeric order'));
  assert.match(content, /You were added as an owner\n\nComment added\n> Comment after ownership/u);
});

test('does not apply aggregate owner_ids to every Story and evaluates ownership per group', () => {
  const aggregateOnly = syntheticEvent({
    ownerIds: [TARGET_MEMBER_ID],
    actions: [
      storyAction(701, 'update', { changes: { workflow_state_id: scalarChange(1, 2) } }),
      storyAction(702, 'update', { changes: { deadline: scalarChange(null, '2025-05-01') } }),
    ],
  });
  assert.equal(processEvent(aggregateOnly, relayOptions).outcome, 'ignored');

  const perGroup = syntheticEvent({
    ownerIds: [TARGET_MEMBER_ID],
    actions: [
      storyAction(701, 'update', {
        name: 'Individually owned',
        changes: {
          owner_ids: ownerIdsChange({ adds: [TARGET_MEMBER_ID] }),
          workflow_state_id: scalarChange(1, 2),
        },
      }),
      storyAction(702, 'update', {
        name: 'Not individually owned',
        changes: { deadline: scalarChange(null, '2025-05-01') },
      }),
    ],
  });
  const result = deliver(perGroup);

  assert.deepEqual(result.storyIds, [701]);
  assert.ok(messageText(result).startsWith('[Individually owned \\(\\#701\\)]'));
  assert.doesNotMatch(messageSummary(result), /2025-05-01/);
});

test('keeps return metadata free of names, values, and comment text', () => {
  const result = deliver(
    syntheticEvent({
      id: '00000000-0000-4000-8000-000000000099',
      ownerIds: [TARGET_MEMBER_ID],
      actions: [
        storyAction(901, 'update', {
          name: 'Private Story Name',
          changes: { workflow_state_id: scalarChange(1, 2) },
        }),
        commentAction(9011, 'create', 901, { changes: { text: { new: 'Private comment body' } } }),
      ],
      references: [workflowReference(2, 'Private workflow name')],
    }),
  );

  const metadata = {
    outcome: result.outcome,
    eventId: result.eventId,
    storyIds: result.storyIds,
    actionTypes: result.actionTypes,
  };
  const serialized = JSON.stringify(metadata);
  assert.doesNotMatch(serialized, /Private Story Name|Private workflow name|Private comment body/);
});

test('reports omitted story groups in the bounded plain-text message', () => {
  const actions = Array.from({ length: 26 }, (_, index) =>
    storyAction(1000 + index, 'create', {
      name: `Synthetic Story ${index + 1}`,
      ownerIds: [TARGET_MEMBER_ID],
    }),
  );

  const result = deliver(syntheticEvent({ actions }));

  assert.equal(result.storyIds.length, 26);
  assert.ok(result.payload.content.length <= 2000);
  assert.match(result.payload.content, /more stories omitted/u);
  assert.ok(result.payload.content.indexOf('Synthetic Story 1') < result.payload.content.indexOf('Synthetic Story 2'));
});

test('keeps multi-Story content within Discord bounds and reports omissions', () => {
  const longName = 'N'.repeat(300);
  const longDeadline = 'D'.repeat(3000);
  const actions = [];

  for (let index = 0; index < 10; index += 1) {
    const storyId = 1100 + index;
    actions.push(
      storyAction(storyId, 'create', { name: longName, ownerIds: [TARGET_MEMBER_ID] }),
      storyAction(storyId, 'update', {
        changes: { deadline: scalarChange('old', longDeadline) },
      }),
    );
  }

  const result = deliver(syntheticEvent({ actions }));

  assert.ok(result.payload.content.length <= 2000);
  assert.match(result.payload.content, /additional changes omitted/u);
  assert.match(result.payload.content, /more stories omitted/u);
});

test('bounds a single Story title and description while reporting omitted change text', () => {
  const result = deliver(
    syntheticEvent({
      actions: [
        storyAction(1201, 'create', {
          name: 'T'.repeat(400),
          ownerIds: [TARGET_MEMBER_ID],
        }),
        storyAction(1201, 'update', {
          changes: { deadline: scalarChange('old', 'D'.repeat(6000)) },
        }),
      ],
    }),
  );
  assert.ok(result.payload.content.length <= 2000);
  assert.ok(messageText(result).startsWith(`[${'T'.repeat(247)}… \\(\\#1201\\)]`));
  assert.match(result.payload.content, /additional changes omitted/u);
});

test('validation diagnostics identify the first rejected field without changing filtering', () => {
  const cases = [
    [null, '$', 'object', 'null'],
    [syntheticEvent({ id: '' }), '$.id', 'nonempty string', 'string'],
    [syntheticEvent({ changedAt: 12 }), '$.changed_at', 'nonempty string', 'number'],
    [syntheticEvent({ memberId: null }), '$.member_id', 'nonempty string', 'null'],
    [syntheticEvent({ version: 'PRIVATE VERSION' }), '$.version', 'v1', 'string'],
    [syntheticEvent({ actions: {} }), '$.actions', 'array', 'object'],
    [syntheticEvent({ actions: [null] }), '$.actions[0]', 'object', 'null'],
    [syntheticEvent({ actions: [{ id: 'PRIVATE ID' }] }), '$.actions[0].id', 'positive safe integer', 'string'],
    [syntheticEvent({ actions: [{ id: 1 }] }), '$.actions[0].entity_type', 'nonempty string', 'undefined'],
    [syntheticEvent({ actions: [{ id: 1, entity_type: 'story' }] }), '$.actions[0].action', 'nonempty string', 'undefined'],
    [syntheticEvent({ actions: [storyAction(1, 'update', { name: null })] }), '$.actions[0].name', 'string', 'null'],
    [syntheticEvent({ actions: [storyAction(1, 'update', { changes: [] })] }), '$.actions[0].changes', 'object', 'array'],
    [syntheticEvent({ actions: [storyAction(1, 'update', { ownerIds: [null] })] }), '$.actions[0].owner_ids', 'array of nonempty strings', 'array'],
    [syntheticEvent({ actions: [commentAction(1, 'create', 'PRIVATE ID')] }), '$.actions[0].story_id', 'positive safe integer', 'string'],
    [syntheticEvent({ ownerIds: false }), '$.owner_ids', 'array of nonempty strings', 'boolean'],
    [syntheticEvent({ references: null }), '$.references', 'array', 'null'],
    [syntheticEvent({ references: [null] }), '$.references[0]', 'object', 'null'],
    [syntheticEvent({ references: [{ id: 'PRIVATE ID' }] }), '$.references[0].id', 'positive safe integer', 'string'],
    [syntheticEvent({ references: [{ id: 1 }] }), '$.references[0].entity_type', 'nonempty string', 'undefined'],
    [syntheticEvent({ references: [{ id: 1, entity_type: 'story', name: 123 }] }), '$.references[0].name', 'nonempty string', 'number'],
  ];
  for (const [event, path, expected, actual] of cases) {
    const issues = [];
    assert.equal(processEvent(event, { ...relayOptions, onInvalid: (issue) => issues.push(issue) }).outcome, 'invalid');
    assert.deepEqual(issues, [{ path, expected, actual }]);
  }
  processEvent(syntheticEvent(), { ...relayOptions, onInvalid: () => assert.fail('valid envelope') });
});

test('observed optional reference shapes do not block eligible changes or bypass filtering', () => {
  for (const shape of observedReferenceShapes) {
    const event = syntheticEvent({
      ownerIds: [TARGET_MEMBER_ID],
      actions: [storyAction(42, 'update', { changes: { workflow_state_id: scalarChange(1, 2) } })],
    });
    delete event.references;
    Object.assign(event, shape);
    assert.equal(messageSummary(deliver(event)), 'Workflow: 2');
    assert.equal(processEvent({ ...event, member_id: TARGET_MEMBER_ID }, relayOptions).outcome, 'ignored');
    assert.equal(processEvent({ ...event, owner_ids: [] }, relayOptions).outcome, 'ignored');
  }
});

test('unnamed workflow references use the ID fallback without hiding available names', () => {
  const event = syntheticEvent({
    ownerIds: [TARGET_MEMBER_ID],
    actions: [storyAction(42, 'update', { changes: { workflow_state_id: scalarChange(1, 2) } })],
    references: [{ id: 2, entity_type: 'workflow-state' }],
  });
  assert.equal(messageSummary(deliver(event)), 'Workflow: 2');
  event.references.push(workflowReference(2, 'Ready'));
  assert.equal(messageSummary(deliver(event)), 'Workflow: Ready');
});

test('relays observed story-comment creation through explicit Story comment_ids.adds', () => {
  for (const reverse of [false, true]) {
    const event = observedCommentCreate();
    if (reverse) event.actions.reverse();
    const result = deliver(event);
    assert.deepEqual(result.storyIds, [501]);
    assert.deepEqual(result.actionTypes, ['comment.create']);
    assert.ok(messageText(result).startsWith('[Example Story \\(\\#501\\)](https://app.shortcut.com/synthetic-workspace/story/501)'));
    assert.equal(messageSummary(result), 'Comment added\n> Example comment text');
  }
});

test('observed comments require an unambiguous explicit association, not primary_id or nearby actions', () => {
  const mutations = [
    (event) => { event.actions.pop(); },
    (event) => { delete event.actions[1].changes.comment_ids; },
    (event) => { event.actions[1].changes.comment_ids = { adds: [9999] }; },
    (event) => { event.actions[1].changes.comment_ids = { adds: ['5011'] }; },
    (event) => { event.actions[1].changes.comment_ids = { adds: [5011, null] }; },
    (event) => { event.actions[1].changes.comment_ids = { removes: [5011] }; },
    (event) => { event.actions[1].action = 'delete'; },
    (event) => { event.actions[0].action = 'delete'; },
    (event) => { event.actions[0].action = 'update'; },
    (event) => { event.actions[0].story_id = 999; },
    (event) => {
      event.actions.push({ ...structuredClone(event.actions[1]), id: 502 });
      event.actions[1].changes.owner_ids = { adds: [TARGET_MEMBER_ID] };
    },
  ];
  for (const mutate of mutations) {
    const event = observedCommentCreate();
    mutate(event);
    const result = processEvent(event, relayOptions);
    // Other eligible changes may still deliver, but ambiguous comment text must not.
    assert.ok(!result.actionTypes.includes('comment.create'));
    assert.equal(JSON.stringify(result.payload ?? {}).includes('Example comment text'), false);
  }
});

test('observed comments preserve ownership and self-action filtering', () => {
  for (const mutate of [
    (event) => { event.member_id = TARGET_MEMBER_ID; },
    (event) => { event.owner_ids = []; },
    (event) => { event.actions.push(storyAction(502, 'update', { changes: { description: scalarChange('a', 'b') } })); },
  ]) {
    const event = observedCommentCreate();
    mutate(event);
    assert.equal(processEvent(event, relayOptions).outcome, 'ignored');
  }
  const event = observedCommentCreate();
  const secondStory = structuredClone(event.actions[1]);
  secondStory.id = 502;
  secondStory.changes.comment_ids.adds = [5021];
  event.actions.push({ ...event.actions[0], id: 5021, text: 'Unowned comment' }, secondStory);
  event.actions[1].changes.owner_ids = { adds: [TARGET_MEMBER_ID] };
  const result = deliver(event);
  assert.deepEqual(result.storyIds, [501]);
  assert.match(messageSummary(result), /Example comment text/);
  assert.doesNotMatch(messageSummary(result), /Unowned comment/);
});

test('observed direct comment text is bounded and omitted when unavailable', () => {
  for (const text of [undefined, null, 12, {}, '   ', 'x'.repeat(210)]) {
    const event = observedCommentCreate();
    if (text === undefined) delete event.actions[0].text;
    else event.actions[0].text = text;
    const description = messageSummary(deliver(event));
    if (typeof text === 'string' && text.trim()) {
      assert.equal(description, `Comment added\n> ${'x'.repeat(199)}…`);
    } else {
      assert.equal(description, 'Comment added');
    }
  }
});

test('comment author names are bounded, escaped, and restricted to eligible groups', () => {
  const event = observedCommentCreate();
  const authorId = event.actions[0].author_id;
  const authorNames = new Map([[authorId, '  Alice *Admin* <@123>\n[link](url)  ']]);
  const result = processEvent(event, { ...relayOptions, authorNames });
  assert.deepEqual(result.commentAuthorIds, [authorId]);
  assert.equal(messageSummary(result),
    '**Alice \\*Admin\\* \\<\u200b@123\\> \\[link\\]\\(url\\)** commented\n> Example comment text');
  assert.match(result.payload.content, new RegExp(`^<@${DISCORD_USER_ID}> \\*\\*Alice.*\\nChanged: `));
  assert.deepEqual(result.payload.allowed_mentions, { users: [DISCORD_USER_ID] });
  authorNames.set(authorId, 'A'.repeat(1000));
  assert.equal(messageSummary(processEvent(event, { ...relayOptions, authorNames })),
    `**${'A'.repeat(79)}…** commented\n> Example comment text`);

  const unowned = structuredClone(event.actions[1]);
  unowned.id = 502;
  unowned.changes.comment_ids.adds = [5021];
  event.actions.push({ ...event.actions[0], id: 5021, author_id: '33333333-3333-4333-8333-333333333333' }, unowned);
  event.actions[1].changes.owner_ids = { adds: [TARGET_MEMBER_ID] };
  assert.deepEqual(processEvent(event, relayOptions).commentAuthorIds, [authorId]);
});

test('plain-text layout separates quotes and preserves story, timestamp, and summary context', () => {
  const event = observedCommentCreate();
  const authorId = event.actions[0].author_id;
  const authorNames = new Map([[authorId, 'Alice Example']]);
  event.actions[1].changes.workflow_state_id = scalarChange(1, 2);
  const result = processEvent(event, { ...relayOptions, authorNames });
  assert.ok(result.payload.content.includes('[Example Story \\(\\#501\\)](https://app.shortcut.com/synthetic-workspace/story/501)'));
  assert.match(result.payload.content, /^<@\d+> \*\*Alice Example\*\* commented > Example comment text.*\nChanged: 2025-01-02T03:04:05\.000Z\n\n/u);
  assert.equal(messageSummary(result), '**Alice Example** commented\n> Example comment text\n\nWorkflow: 2');

  delete event.actions[0].text;
  delete event.actions[1].changes.workflow_state_id;
  assert.equal(messageSummary(processEvent(event, { ...relayOptions, authorNames })),
    '**Alice Example** commented');
});
