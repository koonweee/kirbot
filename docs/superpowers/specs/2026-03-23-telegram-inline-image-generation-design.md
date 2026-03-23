# Telegram Inline Image Generation Design

## Summary

Kirbot should publish successful Codex-generated images directly into Telegram
as standalone photo messages the moment Codex reports each image-generation item
as completed. These image messages should not wait for turn finalization, should
not include captions, and should be sent as separate messages when multiple
images are produced in one turn.

The recommended implementation is to treat the Codex image-generation result as
a remote image URL, download the bytes in Kirbot, validate them, and re-upload
them to Telegram as photos. This keeps Kirbot in control of delivery and avoids
depending on Telegram's remote fetch behavior.

## Goals

- Show generated images inline in Telegram instead of only leaving them implicit
  in Codex output.
- Publish each generated image immediately when the corresponding Codex
  `imageGeneration` item completes.
- Keep generated-image publication separate from final assistant text,
  commentary artifacts, and plan publication.
- Preserve turn completion even if generated-image delivery fails.
- Keep the first implementation narrow and deterministic.

## Non-Goals

- Adding a user-facing Telegram command or mode switch for image generation.
- Changing how Codex decides to generate images.
- Batching multiple generated images into albums.
- Adding captions, prompt summaries, or reply threading to generated-image
  messages.
- Falling back to Telegram document sends in the first pass.

## Product Decisions

### Delivery Timing

- Kirbot posts each generated image as soon as the successful
  `imageGeneration` item is received.
- Kirbot does not wait for `turn/completed`.

### Telegram Presentation

- Each generated image is posted as a standalone Telegram photo message.
- Generated images do not include captions.
- Multiple generated images are posted as separate messages in completion order.
- Generated-image sends should follow Kirbot's normal muted-by-default behavior
  for non-urgent bot output.

### Delivery Strategy

- Kirbot downloads the image from the Codex-provided remote URL and re-uploads
  it to Telegram as a photo.
- Kirbot does not rely on Telegram fetching the remote URL directly.

## Current State

Codex already distinguishes generated-image completion from overall turn
completion:

- generated images appear as `imageGeneration` items in
  [ThreadItem.ts](/home/dev/kirbot/packages/codex-client/src/generated/codex/v2/ThreadItem.ts)
- Kirbot already receives those items on the `item/completed` path in
  [bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts)
- turn finalization is separate and happens later in
  [turn-lifecycle.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/turn-lifecycle.ts)

Kirbot currently has no outbound Telegram media-send primitive. The Telegram
transport in
[telegram-messenger.ts](/home/dev/kirbot/packages/kirbot-core/src/telegram-messenger.ts)
only exposes message text, edits, deletes, callback answers, chat actions, and
inbound file downloads. Successful `imageGeneration` items are effectively
treated as "not a failure" rather than something to publish.

## Proposed Approaches

### 1. Direct URL to Telegram

Pass the Codex image URL straight to Telegram as a photo send.

Pros:

- smallest code diff
- no Kirbot-side download step
- lowest happy-path latency

Cons:

- depends on Telegram being able to fetch the remote URL
- weaker control over content validation and retry behavior
- fragile if Codex image URLs become short-lived or access-controlled

### 2. Download then Re-Upload as Telegram Photo

Download the image in Kirbot, validate it, then upload the bytes to Telegram.

Pros:

- deterministic behavior under Kirbot control
- consistent validation and logging
- isolates Kirbot from Telegram remote-fetch quirks
- fits Kirbot's existing pattern of materializing Telegram-related image bytes

Cons:

- more plumbing than direct URL pass-through
- slightly more latency and memory use

### 3. Hybrid Fallback

Try direct URL first, then fall back to download and re-upload if Telegram
rejects the send.

Pros:

- can be fast on the happy path

Cons:

- adds two delivery paths and two failure surfaces
- more complexity than the feature needs initially

## Recommendation

Use the download-then-re-upload approach.

The feature's value is reliable inline image delivery inside Telegram. Kirbot
should not depend on Telegram's remote-fetch semantics for correctness when it
can cheaply own the bytes itself.

## Architecture

### Immediate Item-Level Publication

Successful generated images should be handled on `item/completed`, not in turn
finalization.

When Kirbot receives an `imageGeneration` item with a successful status and a
non-empty result URL, the lifecycle layer should trigger a dedicated image
publication path immediately. This keeps image sends independent from:

- final assistant text publication
- commentary artifact publication
- plan artifact publication
- footer publication

Turn finalization should remain focused on the text-centric outputs it already
owns.

### Concurrency Contract

In the current bridge, turn-scoped Codex notifications are processed serially.
The first implementation should preserve that model and allow successful
generated-image publication to delay the per-turn notification chain while the
download and Telegram upload are in flight.

This is the narrowest correct contract for the first pass because it avoids:

- introducing off-chain publication tasks
- keeping extra turn state alive after runtime finalization
- adding deduplication bookkeeping outside the existing notification ordering

To keep this bounded, the remote-image fetch and Telegram send path must use
explicit timeouts and size limits. If publication fails, Kirbot records the
failure and then continues processing later turn notifications normally.

### Per-Turn Idempotence

Active turn state should track a per-turn in-memory set of completed
`imageGeneration` item ids that have already been published successfully or
attempted definitively.

Before Kirbot downloads or sends a generated image, it should check this set and
skip publication if the item id is already present. Once Kirbot starts handling
an item id, it should mark that id so replayed or duplicated notifications
cannot publish the same image twice.

This set should live with other active turn state and be cleared automatically
when the turn is finalized.

### Telegram Outbound Media Support

Extend the Telegram transport with an outbound binary photo-send primitive.

This should include:

- a new transport-neutral `TelegramApi` method for photo sends using raw bytes
  plus optional filename and mime-type hints
- a matching `TelegramMessenger` method that applies the same scheduling and
  policy discipline as other visible sends
- bot-process wiring in `apps/bot/src/index.ts` that translates the transport
  payload into the corresponding `grammy` photo-send call

The first version only needs single-photo sending. Albums and documents are out
of scope.

### Remote Image Fetch Helper

Add a small helper responsible for:

- validating that the `result` is an `http` or `https` URL
- downloading the resource with a bounded timeout
- checking that the response is an image
- enforcing a bounded size limit before Telegram upload
- returning upload-ready bytes and a filename hint when possible

This helper should stay narrowly scoped to Codex-generated image publication and
should not become a general media framework in this pass.

## Data Flow

For each successful `imageGeneration` completion:

1. Kirbot receives the completed item from Codex on `item/completed`.
2. The lifecycle coordinator recognizes it as a successful generated image using
   the same first-pass predicate Kirbot already uses for presentation:
   non-empty `result` plus `status` not matching `/fail/i`.
3. Kirbot checks the per-turn published-item-id set and skips the item if it
   was already handled.
4. Kirbot validates and downloads the remote image URL immediately.
5. Kirbot sends the image into the same chat/topic as a standalone Telegram
   photo with no caption.
6. Kirbot continues the turn normally; later text and finalization are
   unaffected.

If multiple generated images arrive during one turn, the same flow runs once per
completed item in arrival order.

## Failure Handling

Generated-image delivery failure must not fail the turn.

If the image URL is invalid, the download fails, validation fails, or Telegram
rejects the photo send:

- Kirbot logs the failure with turn id, item id, URL, and failure stage
- the turn continues normally
- Kirbot appends a dedicated structured activity-log entry for the publication
  failure so commentary can surface it even though the upstream Codex
  `imageGeneration` item itself was successful

Failure stages should be explicit enough to distinguish:

- `invalid_url`
- `download`
- `validation`
- `telegram_send`

Because the first implementation keeps image publication on the serialized
notification path, these failures are recorded inline before later turn events
continue.

The first implementation should not fall back to `sendDocument`. If Telegram
rejects the photo send, Kirbot should fail cleanly and surface that failure
through the new image-publication failure activity-log path.

## Testing

Add focused coverage for:

- outbound Telegram photo-send transport wiring
- immediate standalone photo publication when a successful `imageGeneration`
  item completes
- multiple generated images sent as separate messages in arrival order
- invalid URL rejection
- non-image response rejection
- download timeout or download failure
- Telegram photo-send failure
- replay or duplicate notification coverage proving one `imageGeneration` item
  does not publish twice
- regression coverage showing turn finalization and final assistant text still
  behave correctly after immediate image publication

## Risks

### URL Shape Assumption

The design assumes the current `imageGeneration.result` remains a remote image
URL. If the backend later changes that payload shape, the publication helper
will need to adapt.

### Telegram Photo Constraints

Some valid image responses may still be rejected by Telegram as photos. This is
acceptable in the first version so long as Kirbot fails cleanly and does not
break the turn.

## Rollout Strategy

- Implement as one narrow feature slice.
- Keep existing finalization behavior unchanged except for the new immediate
  image side-effect on successful `imageGeneration`.
- Prefer tests that exercise the lifecycle path directly over broad refactors.
