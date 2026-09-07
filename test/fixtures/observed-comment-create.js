// Reconstructed from authenticated live diagnostics in Herdr, NOT a raw capture.
// Confirmed: story-comment.create, direct text, and matching Story comment_ids.adds.
// All IDs, names, URLs, timestamps, and text are deterministic replacements.
import { OTHER_MEMBER_ID, TARGET_MEMBER_ID } from './synthetic-v1-events.js';

export function observedCommentCreate() {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    changed_at: '2025-01-02T03:04:05.000Z',
    version: 'v1',
    primary_id: 5011,
    member_id: OTHER_MEMBER_ID,
    actions: [
      {
        author_id: OTHER_MEMBER_ID,
        app_url: 'https://app.shortcut.com/example/story/501/comment/5011',
        id: 5011,
        entity_type: 'story-comment',
        action: 'create',
        text: '  Example\tcomment\ntext  ',
      },
      {
        id: 501,
        entity_type: 'story',
        action: 'update',
        name: 'Example Story',
        story_type: 'feature',
        app_url: 'https://app.shortcut.com/example/story/501',
        changes: {
          comment_ids: { adds: [5011] },
          follower_ids: { adds: [OTHER_MEMBER_ID] },
        },
      },
    ],
    owner_ids: [TARGET_MEMBER_ID],
  };
}
