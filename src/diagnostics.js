// Only fixed contract keys are printable: arbitrary object keys can contain private data.
const SAFE_KEYS = new Set([
  'id', 'changed_at', 'member_id', 'owner_ids', 'version', 'primary_id',
  'actions', 'references', 'entity_type', 'action', 'name', 'changes',
  'story_id', 'story', 'comment_id', 'comment_ids', 'comment', 'comments', 'text', 'description',
  'task_ids', 'label_ids', 'follower_ids', 'mention_ids', 'mentioned_member_ids', 'story_type',
  'workflow_state_id', 'deadline', 'estimate', 'old', 'new', 'adds', 'removes',
  'created_at', 'updated_at', 'author_id', 'app_url', 'url',
]);

const ENTITY_TYPES = new Set(['story', 'story-comment', 'comment', 'epic', 'epic-comment', 'task', 'label', 'workflow-state']);
const OPERATIONS = new Set(['create', 'update', 'delete']);

export function eventShape(event) {
  const fields = [];
  const numberPaths = new Map();
  let truncated = false;

  function visit(value, path, depth, fieldName) {
    if (fields.length >= 200) {
      truncated = true;
      return;
    }
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const field = { path, type };
    // Only fixed protocol labels may be printed, never arbitrary string values.
    const labels = fieldName === 'entity_type' ? ENTITY_TYPES : fieldName === 'action' ? OPERATIONS : undefined;
    if (labels && typeof value === 'string') {
      field.knownValue = labels.has(value) ? value : 'unrecognized';
    }
    if (typeof value === 'number') {
      if (numberPaths.has(value)) field.sameNumberAs = numberPaths.get(value);
      else numberPaths.set(value, path);
    }
    fields.push(field);
    if (value === null || typeof value !== 'object') return;

    const keys = Object.keys(value);
    if (depth >= 8) {
      if (keys.length > 0) truncated = true;
      return;
    }
    const limit = Array.isArray(value) ? Math.min(keys.length, 10) : keys.length;
    if (limit < keys.length) truncated = true;
    for (let index = 0; index < limit; index += 1) {
      if (fields.length >= 200) {
        truncated = true;
        break;
      }
      const key = keys[index];
      const segment = Array.isArray(value) ? `[${index}]` : SAFE_KEYS.has(key) ? `.${key}` : `[redacted-key-${index}]`;
      visit(value[key], `${path}${segment}`, depth + 1, key);
    }
  }

  visit(event, '$', 0);
  return { fields, truncated };
}
