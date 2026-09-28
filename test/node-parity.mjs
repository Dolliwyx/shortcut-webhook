// Migration oracle: reads only synthetic fixtures and never contacts an upstream.
import { readFileSync } from 'node:fs';
import { processEvent } from '../src/relay.js';
import { observedCommentCreate } from './fixtures/observed-comment-create.js';
import {
  TARGET_MEMBER_ID, OTHER_MEMBER_ID, DISCORD_USER_ID,
  syntheticEvent, storyAction, scalarChange, workflowReference,
} from './fixtures/synthetic-v1-events.js';

const options = {
  shortcutMemberId: TARGET_MEMBER_ID,
  workspaceSlug: 'synthetic-workspace',
  discordUserId: DISCORD_USER_ID,
};
const cases = JSON.parse(readFileSync(new URL('./fixtures/parity-cases.json', import.meta.url), 'utf8'));
const add = (name, event, overrides = {}) => cases.push({ name, event, options: { ...options, ...overrides } });
const created = (properties = {}) => syntheticEvent({
  actions: [storyAction(42, 'create', { name: 'Example Story', ownerIds: [TARGET_MEMBER_ID], ...properties })],
});
const updated = (field, old, value) => syntheticEvent({
  ownerIds: [TARGET_MEMBER_ID],
  actions: [storyAction(42, 'update', { name: 'Example Story', changes: { [field]: scalarChange(old, value) } })],
});

for (const [i, value] of [null, false, 0, '', [], {}, '  ', 1.5, 9007199254740992].entries()) {
  for (const field of ['id', 'changed_at', 'member_id', 'version', 'actions', 'owner_ids', 'references']) {
    add(`envelope-${field}-${i}`, { ...created(), [field]: value });
  }
  for (const field of ['id', 'entity_type', 'action', 'name', 'changes', 'owner_ids', 'story_id']) {
    const event = created();
    event.actions[0][field] = value;
    add(`action-${field}-${i}`, event);
  }
}
for (const field of ['id', 'changed_at', 'member_id', 'version', 'actions', 'owner_ids', 'references']) {
  const event = created();
  delete event[field];
  add(`missing-${field}`, event);
}
for (const [i, value] of [null, false, true, 0, 2.5, 1e-7, 1e20, '', '  ', 'before', 'after', [], {}].entries()) {
  for (const field of ['workflow_state_id', 'deadline', 'estimate', 'name', 'description', 'story_type']) {
    add(`scalar-${field}-${i}`, updated(field, 'before', value));
  }
}
for (const [i, text] of [
  '<@123> <@!123> <@&456> <#789> @everyone @HERE @hereafter',
  '[click](https://evil.example) www.example.com **bold** _italic_ `code` \\ \\*',
  '[@Alice](shortcutapp://members/member-id) [@Bob *Admin*](SHORTCUTAPP://members/id)',
  '\u00a0\u2000\u2028\ufeffhello\u0085world\u180e',
  '😀'.repeat(100), '😀'.repeat(101), '😀'.repeat(1001),
  'x'.repeat(199) + '😀', 'x'.repeat(255) + '😀',
  'x'.repeat(1999) + '😀', '*'.repeat(2500), 'x\n'.repeat(3000),
].entries()) {
  add(`title-${i}`, created({ name: text }));
  add(`description-${i}`, created({ description: text }));
  const comment = observedCommentCreate();
  comment.actions[0].text = text;
  add(`comment-${i}`, comment);
  add(`author-${i}`, comment, { authorNames: { [OTHER_MEMBER_ID]: text } });
}
for (const [i, changedAt] of [
  '2025-01-02T03:04:05Z', '2025-01-02T03:04:05.123456Z',
  '2025-01-02T03:04:05+05:30', '2025-01-02', 'not a date',
  '1969-12-31T23:59:59.500Z', '2024-02-29T12:00:00Z',
].entries()) {
  add(`timestamp-${i}`, { ...created(), changed_at: changedAt });
}
for (const [i, slug] of ["team(test)", "team !'()*", 'équipe', 'x'.repeat(1100)].entries()) {
  add(`workspace-${i}`, created(), { workspaceSlug: slug });
}
for (const count of [1, 2, 10, 26]) {
  add(`multiple-stories-${count}`, syntheticEvent({ actions: Array.from({ length: count }, (_, i) =>
    storyAction(100 + i, 'create', { name: 'Story 😀 ' + i, ownerIds: [TARGET_MEMBER_ID], description: 'text'.repeat(500) })) }));
}
for (const references of [[], [workflowReference(2, 'Ready')],
  [workflowReference(2, 'Ready'), workflowReference(2, 'Different')],
  [{ id: 2, entity_type: 'workflow-state' }, workflowReference(2, 'Ready')]]) {
  add(`references-${JSON.stringify(references)}`, { ...updated('workflow_state_id', 1, 2), references });
}
for (const reverse of [false, true]) {
  const event = observedCommentCreate();
  if (reverse) event.actions.reverse();
  add(`comment-order-${reverse}`, event);
}
for (const [i, mutate] of [
  e => { e.actions.pop(); },
  e => { e.actions[1].changes.comment_ids.adds = ['5011']; },
  e => { e.actions[0].story_id = 502; },
  e => { e.actions.push({ ...e.actions[1], id: 502 }); },
  e => { e.member_id = TARGET_MEMBER_ID; },
  e => { e.owner_ids = []; },
].entries()) {
  const event = observedCommentCreate();
  mutate(event);
  add(`comment-ambiguity-${i}`, event);
}

process.stdout.write(JSON.stringify(cases.map(item => {
  const settings = item.options ?? options;
  let issue;
  const expected = processEvent(item.event, {
    ...settings,
    authorNames: new Map(Object.entries(settings.authorNames ?? {})),
    onInvalid: value => { issue = value; },
  });
  return { ...item, options: settings, expected, issue };
})));
