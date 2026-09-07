# Synthetic relay fixtures

These fixtures are hand-authored test data, **not** captured Shortcut payloads and not sanitized production data. `observed-reference-shapes.js` reconstructs two field-presence variants confirmed by user-provided live diagnostics: absent `references` and a reference without `name`. Its IDs and entity-type values are synthetic, not observed values.

`observed-comment-create.js` reconstructs the comment creation relationship confirmed
by authenticated live diagnostics in Herdr: `story-comment.create`, direct `text`,
and its ID in a Story update's `changes.comment_ids.adds`. IDs and private values
are replacements; redacted fields are omitted. It is not a raw payload capture.

The relay supports these confirmed and provisional shapes:

- A `story` action associates with the Story identified by its own positive numeric `id`.
- A legacy synthetic `comment` action associates through its direct positive numeric `story_id`.
- A real `story-comment.create` associates through a Story update's numeric `changes.comment_ids.adds`. Missing matches, matches to different Story IDs, and conflicting direct `story_id` values are ignored. `primary_id` is not used: live diagnostics showed it identifying the comment, not the Story.
- A created Story may expose direct `owner_ids` as an array of member-ID strings.
- A Story ownership update may expose `changes.owner_ids.adds` and/or `changes.owner_ids.removes` as arrays of member-ID strings.
- Event-level `owner_ids` is considered only after exactly one Story ID resolves from the remaining directly associated Story/comment create or update actions; deletion/task/Epic actions are excluded first.
- `references` can be absent. When present, it is an array of objects with positive numeric `id`, nonempty string `entity_type`, and optional nonempty string `name`. Workflow names use `entity_type: "workflow-state"`; unnamed references do not participate in name lookup.
- For `story-comment.create`, text is read from direct `text`; legacy synthetic `comment` actions still use `changes.text.new`. Non-string or absent text produces an alert without an excerpt.
- Real `story-comment.update` association is not yet confirmed and remains ignored; capture its shape separately before implementing it.

Unsupported or ambiguous associations are intentionally ignored rather than inferred.

## Collect local shape diagnostics

Stop the running relay with Ctrl+C, then restart it from the repository root:

```sh
SHORTCUT_DIAGNOSTICS=1 pnpm start
```

This temporary mode adds an `outcome: "diagnostic"` line for each authenticated,
parseable event, including ignored and eligible events. Normal processing and
outcome logs remain unchanged. Unsigned requests and malformed JSON never produce
shape diagnostics. No raw payload files are written.

Have a teammate change a Story you own, one operation at a time: workflow state,
ownership addition/removal, deadline, estimate, Story creation, and comment
creation/update. Note which operation produced each diagnostic line. Your own
changes are suppressed, although their authenticated shapes are still reported.

For a rejected event, `validationError` identifies the first failing path, the
expected constraint, and the actual type. For example, a string reference ID
would report `$.references[0].id`, expected `positive safe integer`, actual
`string`. This is an example, not evidence of a captured event.

`shape.fields` lists paths and types, not IDs, names, or text. `knownValue` reports
only recognized entity/operation labels (such as `story-comment` and `create`);
arbitrary labels become `unrecognized`. `sameNumberAs` points to the first earlier
path with an equal numeric value, allowing ID relationships to be checked without
printing IDs. Numeric equality alone does not prove a semantic relationship.
Only fixed contract field names are printed, including `comment_ids`; unknown keys
become `[redacted-key-N]` because object keys can also contain private data.
`memberChecks.selfAuthored` compares the event author with the configured member;
`aggregateOwnerMatch` checks the top-level owner list, not per-Story eligibility.
Inspection stops at 10 items per array,
200 total nodes, or 8 nested levels; `shape.truncated: true` marks omitted content.
The diagnostic line contains no event ID. Record the operation you just triggered;
concurrent requests can interleave logs, so adjacency alone does not establish
which ordinary outcome log belongs to it.

Share the diagnostic line and operation, not raw workspace payloads or secrets.
Compare the observed structure with the
[Shortcut webhook contract](https://developer.shortcut.com/api/webhook/v1), then
add a fixture using deterministic replacement IDs, names, and text and a regression
test before adjusting validation. The fixed labels and numeric equality paths can
confirm an explicit relationship such as a comment ID in a Story's
`changes.comment_ids.adds`. Unknown labels, redacted fields, truncation, or ambiguous
associations still require targeted diagnostics or a manually sanitized sample
with relationships preserved. Do not label reconstructed examples as raw
captures, commit private payloads, or use public webhook-capture services.

Restart with plain `pnpm start` to disable diagnostics (also remove any
`SHORTCUT_DIAGNOSTICS=1` setting from your shell or `.env`). Leave diagnostics off
in production to retain the metadata-only logging contract in `MVP.md`.
