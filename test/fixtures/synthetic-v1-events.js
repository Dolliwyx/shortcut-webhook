// SYNTHETIC TEST DATA ONLY. This file is not a captured or sanitized Shortcut payload.
//
// Provisional shapes are documented in README.md:
// - story -> own numeric id
// - comment -> direct numeric story_id
// - create -> direct owner_ids
// - ownership update -> changes.owner_ids.adds/removes
// - workflow references -> references[] object entries

export const TARGET_MEMBER_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_MEMBER_ID = '22222222-2222-4222-8222-222222222222';
export const DISCORD_USER_ID = '123456789012345678';

export function syntheticEvent({
  id = '00000000-0000-4000-8000-000000000001',
  changedAt = '2025-01-02T03:04:05.000Z',
  memberId = OTHER_MEMBER_ID,
  version = 'v1',
  actions = [],
  references = [],
  ownerIds,
  ...rest
} = {}) {
  const event = {
    id,
    changed_at: changedAt,
    member_id: memberId,
    version,
    actions,
    references,
    ...rest,
  };

  if (ownerIds !== undefined) {
    event.owner_ids = ownerIds;
  }

  return event;
}

export function storyAction(id, action, { name, changes, ownerIds, ...rest } = {}) {
  const result = {
    id,
    entity_type: 'story',
    action,
    ...rest,
  };

  if (name !== undefined) {
    result.name = name;
  }
  if (changes !== undefined) {
    result.changes = changes;
  }
  if (ownerIds !== undefined) {
    result.owner_ids = ownerIds;
  }

  return result;
}

export function commentAction(id, action, storyId, { changes, ...rest } = {}) {
  const result = {
    id,
    entity_type: 'comment',
    action,
    story_id: storyId,
    ...rest,
  };

  if (changes !== undefined) {
    result.changes = changes;
  }

  return result;
}

export function scalarChange(oldValue, newValue) {
  return { old: oldValue, new: newValue };
}

export function ownerIdsChange({ adds, removes } = {}) {
  const result = {};
  if (adds !== undefined) {
    result.adds = adds;
  }
  if (removes !== undefined) {
    result.removes = removes;
  }
  return result;
}

export function workflowReference(id, name) {
  return { id, entity_type: 'workflow-state', name };
}
