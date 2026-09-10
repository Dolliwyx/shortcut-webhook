const MAX_EMBED_TITLE = 256;
const MAX_EMBED_DESCRIPTION = 4096;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_EMBED_CHARACTERS = 6000;
const MAX_FIELDS = 25;
const MAX_STORY_FIELDS_WITH_OMISSION = 24;
const MAX_COMMENT_EXCERPT = 200;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Filter one validated Shortcut v1 event and construct its Discord payload.
 *
 * The only supported action associations are intentionally narrow:
 * - story actions use their own numeric id;
 * - legacy comment actions use a direct numeric story_id;
 * - story-comment creation links through a Story update's comment_ids.adds.
 * options.onInvalid, when provided, receives the first rejection's path and
 * expected/actual types, never the rejected value.
 */
export function processEvent(event, options) {
  const envelope = validateEnvelope(event, options?.onInvalid);
  if (envelope === null) {
    return emptyResult('invalid');
  }

  const { eventId, workflowReferences } = envelope;
  if (!hasUsableOptions(options)) {
    return emptyResult('invalid', eventId);
  }

  // Envelope validation deliberately precedes self-action suppression.
  if (event.member_id === options.shortcutMemberId) {
    return emptyResult('ignored', eventId);
  }

  const { groupsByStoryId, resolvedStoryIds } = collectGroups(event.actions);
  const eligibleGroups = evaluateGroups({
    groupsByStoryId,
    resolvedStoryIds,
    aggregateOwnerIds: event.owner_ids,
    shortcutMemberId: options.shortcutMemberId,
    workflowReferences,
    authorNames: options.authorNames,
  });

  if (eligibleGroups.length === 0) {
    return emptyResult('ignored', eventId);
  }

  return {
    outcome: 'deliver',
    payload: buildDiscordPayload(event.changed_at, eligibleGroups, options),
    eventId,
    storyIds: eligibleGroups.map((group) => group.storyId),
    actionTypes: actionTypesFor(eligibleGroups),
    commentAuthorIds: [...new Set(eligibleGroups.flatMap((group) => group.actionRecords
      .filter((record) => record.entityType === 'comment' && typeof record.action.author_id === 'string')
      .map((record) => record.action.author_id)))],
  };
}

function validateEnvelope(event, onInvalid) {
  const fail = (path, expected, value) => {
    onInvalid?.({
      path,
      expected,
      actual: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    });
    return null;
  };

  if (!isRecord(event)) return fail('$', 'object', event);
  for (const field of ['id', 'changed_at', 'member_id']) {
    if (!isNonemptyString(event[field])) return fail(`$.${field}`, 'nonempty string', event[field]);
  }
  if (event.version !== 'v1') return fail('$.version', 'v1', event.version);
  if (!Array.isArray(event.actions)) return fail('$.actions', 'array', event.actions);

  for (const [index, action] of event.actions.entries()) {
    const path = `$.actions[${index}]`;
    if (!isRecord(action)) return fail(path, 'object', action);
    if (!isNumericId(action.id)) return fail(`${path}.id`, 'positive safe integer', action.id);
    for (const field of ['entity_type', 'action']) {
      if (!isNonemptyString(action[field])) return fail(`${path}.${field}`, 'nonempty string', action[field]);
    }
    if (hasOwn(action, 'name') && typeof action.name !== 'string') {
      return fail(`${path}.name`, 'string', action.name);
    }
    if (hasOwn(action, 'changes') && !isRecord(action.changes)) {
      return fail(`${path}.changes`, 'object', action.changes);
    }
    if (hasOwn(action, 'owner_ids') && !isOwnerList(action.owner_ids)) {
      return fail(`${path}.owner_ids`, 'array of nonempty strings', action.owner_ids);
    }
    if (hasOwn(action, 'story_id') && !isNumericId(action.story_id)) {
      return fail(`${path}.story_id`, 'positive safe integer', action.story_id);
    }
  }

  if (hasOwn(event, 'owner_ids') && !isOwnerList(event.owner_ids)) {
    return fail('$.owner_ids', 'array of nonempty strings', event.owner_ids);
  }
  const references = hasOwn(event, 'references') ? event.references : [];
  if (!Array.isArray(references)) return fail('$.references', 'array', references);
  for (const [index, reference] of references.entries()) {
    const path = `$.references[${index}]`;
    if (!isRecord(reference)) return fail(path, 'object', reference);
    if (!isNumericId(reference.id)) return fail(`${path}.id`, 'positive safe integer', reference.id);
    if (!isNonemptyString(reference.entity_type)) {
      return fail(`${path}.entity_type`, 'nonempty string', reference.entity_type);
    }
    if (hasOwn(reference, 'name') && !isNonemptyString(reference.name)) {
      return fail(`${path}.name`, 'nonempty string', reference.name);
    }
  }

  return { eventId: event.id, workflowReferences: buildWorkflowReferenceLookup(references) };
}

function buildWorkflowReferenceLookup(references) {
  const referencesById = new Map();
  for (const reference of references) {
    if (reference.entity_type !== 'workflow-state' || !isNonemptyString(reference.name)) {
      continue;
    }

    const key = String(reference.id);
    const name = normalizeInlineText(reference.name);
    const existing = referencesById.get(key);

    if (existing === undefined) {
      referencesById.set(key, name);
    } else if (existing !== name) {
      // Conflicting references are ambiguous; use the ID rather than guessing.
      referencesById.set(key, null);
    }
  }

  return referencesById;
}

function hasUsableOptions(options) {
  return (
    isRecord(options) &&
    isNonemptyString(options.shortcutMemberId) &&
    isNonemptyString(options.workspaceSlug) &&
    typeof options.discordUserId === 'string' &&
    /^\d+$/.test(options.discordUserId)
  );
}

function collectGroups(actions) {
  const groupsByStoryId = new Map();
  const resolvedStoryIds = new Set();
  const addedCommentStories = indexAddedComments(actions);

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];

    if (action.entity_type === 'story') {
      if (!isNumericId(action.id) || (action.action !== 'create' && action.action !== 'update')) {
        continue;
      }

      resolvedStoryIds.add(action.id);
      addActionToGroup(groupsByStoryId, action.id, {
        action,
        index,
        entityType: 'story',
        operation: action.action,
      });
      continue;
    }

    let storyId;
    if (action.entity_type === 'comment' && (action.action === 'create' || action.action === 'update')) {
      storyId = action.story_id;
    } else if (action.entity_type === 'story-comment' && action.action === 'create') {
      storyId = addedCommentStories.get(action.id);
    }
    if (!isNumericId(storyId) || (hasOwn(action, 'story_id') && action.story_id !== storyId)) {
      continue;
    }
    resolvedStoryIds.add(storyId);
    addActionToGroup(groupsByStoryId, storyId, {
      action,
      index,
      entityType: 'comment',
      operation: action.action,
    });
  }

  return { groupsByStoryId, resolvedStoryIds };
}

function indexAddedComments(actions) {
  const storiesByCommentId = new Map();
  for (const action of actions) {
    if (action.entity_type !== 'story' || action.action !== 'update') continue;
    const change = action.changes?.comment_ids;
    if (!isRecord(change) || !Array.isArray(change.adds) || !change.adds.every(isNumericId)) continue;
    for (const commentId of change.adds) {
      const existing = storiesByCommentId.get(commentId);
      // A comment claimed by multiple Stories is ambiguous, not a first-match win.
      storiesByCommentId.set(commentId, existing === undefined || existing === action.id ? action.id : null);
    }
  }
  return storiesByCommentId;
}

function addActionToGroup(groupsByStoryId, storyId, actionRecord) {
  let group = groupsByStoryId.get(storyId);
  if (group === undefined) {
    group = { storyId, actionRecords: [] };
    groupsByStoryId.set(storyId, group);
  }

  group.actionRecords.push(actionRecord);
}

function evaluateGroups({
  groupsByStoryId,
  resolvedStoryIds,
  aggregateOwnerIds,
  shortcutMemberId,
  workflowReferences,
  authorNames,
}) {
  const aggregateOwnershipApplies =
    resolvedStoryIds.size === 1 && ownerListIncludes(aggregateOwnerIds, shortcutMemberId);
  const eligibleGroups = [];

  for (const group of groupsByStoryId.values()) {
    let ownedByCreation = false;
    let ownershipAdded = false;
    let ownershipRemoved = false;
    const summaries = [];

    for (const actionRecord of group.actionRecords) {
      const { action, entityType, operation } = actionRecord;

      if (entityType === 'comment') {
        const excerpt = commentExcerpt(action);
        const name = authorNames?.get(action.author_id);
        const author = isNonemptyString(name)
          ? `**${clipWithEllipsis(normalizeInlineText(name), 80).replace(/[\\`*_~|<>\[\]()]/g, '\\$&')}**`
          : null;
        const label = operation === 'create'
          ? (author ? `${author} commented` : 'Comment added')
          : (author ? `Comment by ${author} updated` : 'Comment updated');
        summaries.push({
          index: actionRecord.index,
          actionType: `comment.${operation}`,
          text: excerpt === null ? label : `${label}\n> ${excerpt}`,
        });
        continue;
      }

      if (operation === 'create') {
        if (ownerListIncludes(action.owner_ids, shortcutMemberId)) {
          ownedByCreation = true;
        }
        summaries.push({
          index: actionRecord.index,
          actionType: 'story.create',
          text: isNonemptyString(action.description)
            ? `Story created\n\n${action.description.trim()}`
            : 'Story created',
        });
        continue;
      }

      const ownerChange = ownerIdsChange(action.changes);
      if (ownerChange !== null) {
        if (ownerChange.adds.includes(shortcutMemberId)) {
          ownershipAdded = true;
          summaries.push({
            index: actionRecord.index,
            actionType: 'story.update',
            text: 'You were added as an owner',
          });
        }
        if (ownerChange.removes.includes(shortcutMemberId)) {
          ownershipRemoved = true;
          summaries.push({
            index: actionRecord.index,
            actionType: 'story.update',
            text: 'You were removed as an owner',
          });
        }
      }

      const workflowChange = scalarChange(action.changes, 'workflow_state_id');
      if (workflowChange !== null) {
        summaries.push({
          index: actionRecord.index,
          actionType: 'story.update',
          text: `Workflow: ${workflowDisplayValue(workflowChange.new, workflowReferences)}`,
        });
      }

      const deadlineChange = scalarChange(action.changes, 'deadline');
      if (deadlineChange !== null) {
        summaries.push({
          index: actionRecord.index,
          actionType: 'story.update',
          text: `Deadline: ${displayValue(deadlineChange.new, 'No deadline')}`,
        });
      }

      const estimateChange = scalarChange(action.changes, 'estimate');
      if (estimateChange !== null) {
        summaries.push({
          index: actionRecord.index,
          actionType: 'story.update',
          text: `Estimate: ${displayValue(estimateChange.new, 'No estimate')}`,
        });
      }
    }

    if (!(aggregateOwnershipApplies || ownedByCreation || ownershipAdded || ownershipRemoved) || summaries.length === 0) {
      continue;
    }

    const firstEligibleIndex = Math.min(...summaries.map((summary) => summary.index));
    eligibleGroups.push({
      ...group,
      summaries,
      firstEligibleIndex,
      title: storyTitle(group),
    });
  }

  return eligibleGroups.sort((left, right) => left.firstEligibleIndex - right.firstEligibleIndex);
}

function ownerIdsChange(changes) {
  if (!isRecord(changes) || !hasOwn(changes, 'owner_ids') || !isRecord(changes.owner_ids)) {
    return null;
  }

  const change = changes.owner_ids;
  const hasAdds = hasOwn(change, 'adds');
  const hasRemoves = hasOwn(change, 'removes');
  if (!hasAdds && !hasRemoves) {
    return null;
  }

  const adds = hasAdds ? change.adds : [];
  const removes = hasRemoves ? change.removes : [];
  if (!isOwnerList(adds) || !isOwnerList(removes)) {
    return null;
  }

  return { adds, removes };
}

function scalarChange(changes, field) {
  if (!isRecord(changes) || !hasOwn(changes, field) || !isRecord(changes[field])) {
    return null;
  }

  const change = changes[field];
  if (
    !hasOwn(change, 'old') ||
    !hasOwn(change, 'new') ||
    !isDisplayScalar(change.old) ||
    !isDisplayScalar(change.new) ||
    Object.is(change.old, change.new)
  ) {
    return null;
  }

  return change;
}

function commentExcerpt(action) {
  const text = action.entity_type === 'story-comment' ? action.text : action.changes?.text?.new;
  if (typeof text !== 'string') return null;

  const normalized = normalizeInlineText(text);
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length <= MAX_COMMENT_EXCERPT) {
    return normalized;
  }

  return `${clipText(normalized, MAX_COMMENT_EXCERPT - 1)}…`;
}

function workflowDisplayValue(value, workflowReferences) {
  if (isNumericId(value)) {
    const referenceName = workflowReferences.get(String(value));
    if (typeof referenceName === 'string') {
      return referenceName;
    }
  }

  return displayValue(value, 'No workflow state');
}

function displayValue(value, nullLabel) {
  if (value === null) {
    return nullLabel;
  }
  if (typeof value === 'string') {
    const normalized = normalizeInlineText(value);
    return normalized.length === 0 ? nullLabel : normalized;
  }
  return String(value);
}

function storyTitle(group) {
  for (const actionRecord of group.actionRecords) {
    if (actionRecord.entityType !== 'story' || typeof actionRecord.action.name !== 'string') {
      continue;
    }

    const name = normalizeInlineText(actionRecord.action.name);
    if (name.length > 0) {
      return name;
    }
  }

  return null;
}

function buildDiscordPayload(changedAt, groups, options) {
  const payload = {
    content: `<@${options.discordUserId}>`,
    allowed_mentions: { users: [options.discordUserId] },
    embeds: [],
  };

  if (groups.length === 1) {
    const group = groups[0];
    payload.embeds.push({
      title: storyLabel(group),
      url: storyUrl(options.workspaceSlug, group.storyId),
      description: fitTextWithOmission(summaryText(group), MAX_EMBED_DESCRIPTION),
      timestamp: changedAt,
    });
    return payload;
  }

  const title = clipWithEllipsis(`${groups.length} Shortcut Stories changed`, MAX_EMBED_TITLE);
  payload.embeds.push({
    title,
    timestamp: changedAt,
    fields: multiStoryFields(title, groups, options.workspaceSlug),
  });
  return payload;
}

function multiStoryFields(embedTitle, groups, workspaceSlug) {
  const storyFields = groups.map((group) => storyField(group, workspaceSlug));
  const allFieldsFit =
    storyFields.length <= MAX_FIELDS &&
    embedTitle.length + storyFields.reduce((total, field) => total + fieldCharacterCount(field), 0) <= MAX_EMBED_CHARACTERS;

  if (allFieldsFit) {
    return storyFields;
  }

  // Reserve a field before adding Story fields so an omission report always fits.
  const reserve = omissionField(groups.length);
  let characterCount = embedTitle.length + fieldCharacterCount(reserve);
  const fields = [];

  for (let index = 0; index < storyFields.length && index < MAX_STORY_FIELDS_WITH_OMISSION; index += 1) {
    const field = storyFields[index];
    if (characterCount + fieldCharacterCount(field) > MAX_EMBED_CHARACTERS) {
      break;
    }
    fields.push(field);
    characterCount += fieldCharacterCount(field);
  }

  fields.push(omissionField(groups.length - fields.length));
  return fields;
}

function storyField(group, workspaceSlug) {
  const link = `[Open Story](${storyUrl(workspaceSlug, group.storyId)})`;
  const prefix = `${link}\n`;
  let value;

  if (prefix.length >= MAX_FIELD_VALUE) {
    value = fitTextWithOmission(prefix, MAX_FIELD_VALUE, '… Story link truncated');
  } else {
    value = `${prefix}${fitTextWithOmission(summaryText(group), MAX_FIELD_VALUE - prefix.length)}`;
  }

  return {
    name: storyLabel(group),
    value,
  };
}

function omissionField(omittedCount) {
  const noun = omittedCount === 1 ? 'Story group' : 'Story groups';
  return {
    name: 'Additional Stories',
    value: `${omittedCount} ${noun} omitted due to Discord embed limits.`,
  };
}

function storyLabel(group) {
  if (group.title === null) {
    return `Story #${group.storyId}`;
  }

  const suffix = ` (#${group.storyId})`;
  if (group.title.length + suffix.length <= MAX_FIELD_NAME) {
    return `${group.title}${suffix}`;
  }

  return `${clipWithEllipsis(group.title, MAX_FIELD_NAME - suffix.length)}${suffix}`;
}

function storyUrl(workspaceSlug, storyId) {
  return `https://app.shortcut.com/${encodeURIComponent(workspaceSlug)}/story/${storyId}`;
}

function summaryText(group) {
  const separator = group.summaries.some((summary) => summary.actionType.startsWith('comment.')) ? '\n\n' : '\n';
  return group.summaries.map((summary) => summary.text).join(separator);
}

function actionTypesFor(groups) {
  const actionRecords = groups
    .flatMap((group) => group.summaries)
    .sort((left, right) => left.index - right.index);
  const actionTypes = [];

  for (const actionRecord of actionRecords) {
    if (!actionTypes.includes(actionRecord.actionType)) {
      actionTypes.push(actionRecord.actionType);
    }
  }

  return actionTypes;
}

function emptyResult(outcome, eventId) {
  const result = {
    outcome,
    storyIds: [],
    actionTypes: [],
  };

  if (eventId !== undefined) {
    result.eventId = eventId;
  }

  return result;
}

function fitTextWithOmission(text, maximum, omission = '… additional changes omitted') {
  if (text.length <= maximum) {
    return text;
  }
  if (maximum <= omission.length) {
    return clipText(omission, maximum);
  }

  return `${clipText(text, maximum - omission.length)}${omission}`;
}

function clipWithEllipsis(text, maximum) {
  if (text.length <= maximum) {
    return text;
  }
  if (maximum <= 1) {
    return clipText('…', maximum);
  }

  return `${clipText(text, maximum - 1)}…`;
}

function clipText(text, maximum) {
  if (text.length <= maximum) {
    return text;
  }

  let end = maximum;
  const lastCodeUnit = text.charCodeAt(end - 1);
  const nextCodeUnit = text.charCodeAt(end);
  if (isHighSurrogate(lastCodeUnit) && isLowSurrogate(nextCodeUnit)) {
    end -= 1;
  }

  return text.slice(0, end);
}

function fieldCharacterCount(field) {
  return field.name.length + field.value.length;
}

function normalizeInlineText(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

function ownerListIncludes(value, memberId) {
  return isOwnerList(value) && value.includes(memberId);
}

function isOwnerList(value) {
  return Array.isArray(value) && value.every(isNonemptyString);
}

function isDisplayScalar(value) {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isNumericId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
