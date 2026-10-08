# Kit unsubscribe tag relay

AI Hero's unsubscribe tag is `8244351` (`AI_HERO_UNSUBSCRIBED_TAG_ID`). Applying it can leave the Kit subscriber active. The signed `/api/kit/webhook` handler therefore treats that tag as a stop independently of subscriber state.

## Event contract

Kit's current **Kit-Webhooks/2.0** event is `subscriber.tag_added`. Its `data` contains `subscriber` and `tag`, including `tag.id`. The older subscription name is `subscriber.tag_add`; the handler accepts both names inside the signed event envelope. It does not add an unsigned legacy webhook endpoint.

The handler queues the same internal `email-preferences/contact-unsubscribed` event as a cancellation, for `newsletter` and `ai-skills`. The capture function records `contact.unsubscribed` in the ContactEvent log. It also sends the existing authority directory stop for a known Kit identity.

For a tag action, queue IDs, directory keys, and ContactEvent semantic keys use the Kit subscriber ID, tag ID, canonical event action time, and preference or event type. A retry or re-emitted event UUID cannot write the stop twice. A later tag action gets a new semantic key, so a second unsubscribe after a fresh double opt-in is not lost. Missing or invalid tag action times are rejected for retry rather than replaced with receipt time. Other tags are ignored.

## Directory births

The shared delivery admission checks directory births as well as value-path births. It runs on live and bulk Inngest delivery, direct fallback delivery, and outbox replay.

Before posting `contact.created`, it reads the local contact stop rule and current tags for the birth's Kit subscriber ID and stored Kit identities:

- An active local unsubscribe or tag `8244351` sets `payload.lifecycle` to `unsubscribed`.
- A local bounce or complaint sets it to `bounced`.
- A later recorded fresh double opt-in can lift an old local unsubscribe, but a still-present unsubscribe tag continues to stop the birth.
- An untagged contact without an active local stop keeps the existing provisional birth.
- A failed local or Kit read, missing Kit credential, or missing linked Kit subscriber fails closed. Delivery retries rather than sending an uncertain provisional birth.
- Already-stopped replay payloads cannot become provisional.

The birth keeps its existing timestamp, source metadata and `directory:seed:<contactId>` key. `sourceLifecycle` alone does not select a stopped directory state; `payload.lifecycle` must carry the stop.

Kit reads use the existing paginated, rate-limited v4 reader and `CONVERTKIT_V4_API_KEY` (falling back to `CONVERTKIT_API_KEY`). No subscriber, tag, endpoint, or suppression writes are performed by the standing reader.

## Endpoint subscription prerequisite

Documentation confirms that the current webhook generation supports tag events. It does **not** prove the live AI Hero endpoint subscribes to them. Live subscription readback remains required; this change does not register or update an endpoint.

An authorized operator should:

1. `GET https://api.kit.com/v4/webhook_endpoints`, following pagination, with `X-Kit-Api-Key` supplied privately.
2. Find the endpoint whose URL is the production `/api/kit/webhook` route. Read its full current `events` list, `status`, and `created_by_app`.
3. Confirm it is active and includes `subscriber.tag_added` (not the legacy `subscriber.tag_add` subscription name).
4. Only under separate approval for Kit writes, if missing, `PATCH /v4/webhook_endpoints/{id}` with `events` equal to the **entire existing list plus `subscriber.tag_added`**. Kit replaces the whole list; do not send only the addition. Preserve the other endpoint settings and signing secret. An OAuth-created endpoint must be updated by its owning app, not an unrelated API key.
5. Read the endpoint back and confirm the full list and active status. Do not rotate its secret as part of this change.

Deploying the handler without the tag subscription does not close the immediate webhook gap. No deployment, subscription mutation, or historical replay is part of this packet.

## Sources

- [Kit event types](https://developers.kit.com/webhooks/event-types)
- [Kit delivery format](https://developers.kit.com/webhooks/delivery-format)
- [List webhook endpoints](https://developers.kit.com/api-reference/webhooks/list-webhook-endpoints)
- [Update a webhook endpoint](https://developers.kit.com/api-reference/webhooks/update-a-webhook-endpoint)

## Checks

- Signed tag delivery, unrelated tags, duplicate/re-emitted deliveries, and invalid action times: `src/app/api/kit/webhook/route.test.ts`.
- Durable ContactEvent dedupe and distinct later actions: `src/lib/subscriber-marketing/lifecycle-contact-events.test.ts`.
- Tag-only stopped births, local stop/lift rules, stored aliases, and fail-closed Kit reads: `src/lib/subscriber-marketing/drovr-directory-birth-standing.test.ts`.
- Directory-only live/bulk batches and failed standing reads: `src/inngest/functions/drovr-events-deliver.test.ts`.
- Direct, fallback, and outbox stopped-birth payloads: `src/lib/subscriber-marketing/drovr-directory-birth-roads.test.ts`.
