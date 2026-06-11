# AI Hero

The AI Hero application, courses, cohorts, events, and free tutorials teaching engineers to build with AI.

## Language

### Navigation surfaces

**Primary nav**:
The site header. Rich mega-menus for Learn, Live, and Browse all, driven by `useNavLinks()`. Hover-triggered, image-rich, optimized for discovery.
_Avoid_: top nav, main nav

**Footer nav**:
The site footer. Flat link columns mirroring primary nav data, plus account, machine-readable links, and legal copy. Always-visible, scannable, optimized for users who reach the bottom of a page.
_Avoid_: bottom nav

**Wrangler**:
The footer column dedicated to machine-readable artifacts (`/sitemap.md`, `/llms.txt`, `/rss.xml`) targeted at agents, tools, and developers, not human browsers. The name signals "this corner of the footer is for machines."
_Avoid_: Resources, Developers, Meta

**Live SPT Receipt**:
The end-to-end proof required before publicly linking the Agentic Commerce Contract, showing live Link CLI SPT issuance, exact offer-to-SPT amount match, successful PaymentIntent, succeeded Agentic Commerce Order, Agentic Paid Purchase Record, one-seat Claim Token coupon, working product-specific `?coupon=` claim URL, successful Claim Token redemption into an Agentic Redeemed Access Purchase, normal claimant access email, admin chain visibility, and raw Claim Token redaction from ordinary logs.
_Avoid_: test-mode-only proof, PaymentIntent-only proof, public docs before redemption is proven

**Agentic Commerce Contract**:
A machine-readable public contract, built on AI Hero's existing `/sitemap.md`, `/llms.txt`, and Wrangler discovery surfaces, that documents Agentic Offer Quote, Public Agentic Checkout Endpoint, Agentic Claim Redemption schemas, and agent-first error envelopes with `ok`, machine-readable `code`, plain-language `fix`, and `next_actions`, and should not be publicly linked before a Live SPT Receipt exists.
_Avoid_: hidden endpoint, prose-only payment instructions, MCP-first discovery before schema docs exist, HTTP-only errors for agent workflows, public docs before live-mode proof

### Content types in nav

**Course**:
A paid, structured learning resource (e.g., "AI SDK v6 Crash Course"). Lives under `/workshops/*`.
_Avoid_: workshop (used in URL only), class

**Free Tutorial**:
A free, standalone learning resource (e.g., "LLM Fundamentals"). Has a featured slot in primary nav.
_Avoid_: free course, guide

**AI Coding Dictionary**:
A free reference surface for plain-English AI coding vocabulary. Lives canonically at `/ai-coding-dictionary` with one canonical entry page per term at `/ai-coding-dictionary/[slug]`. Legacy `/dictionary` routes redirect to the canonical paths.
_Avoid_: glossary import, database copy, GitHub-backed source in user-facing copy

**Dictionary Search Document**:
A Typesense document representing either the AI Coding Dictionary index page or one dictionary entry page in the existing AI Hero content search collection. Use `type: "dictionary"` for the index page and `type: "dictionary-entry"` for individual entries. Use stable app-route IDs: `ai-coding-dictionary` for the index page and `ai-coding-dictionary:{slug}` for entries. Dictionary source files have YAML frontmatter, including `description` and optional `aliases`; v1 should stay inside the existing `TypesenseResourceSchema`: put frontmatter `description` in `summary`, put searchable body text in `description`, and append aliases into `description` as plain text so aliases are searchable without changing the Typesense collection schema. Search hit routing should use shared resource paths, with `dictionary` resolving to `/ai-coding-dictionary` and `dictionary-entry` resolving to `/ai-coding-dictionary/{slug}`.
_Avoid_: separate search collection, bespoke dictionary-only search schema, GitHub paths as document IDs, ignoring dictionary frontmatter, new dictionary-specific schema fields before they are needed, AI Hero-only search route special cases

**Dictionary Refresh Event**:
An Inngest event emitted when the AI Coding Dictionary source should be re-indexed. Use event name `ai-coding-dictionary/source.changed`. GitHub webhooks for `mattpocock/dictionary-of-ai-coding` should emit this event after signature verification, using a dedupe ID like `ai-coding-dictionary:{githubDeliveryId}` when a delivery ID is available. Event data should be minimal metadata, such as `repositoryFullName`, `ref`, `after`, `deliveryId`, and `source`. The event is an invalidation signal, not source content; the Inngest function should revalidate the `ai-coding-dictionary` cache tag, re-fetch the dictionary, and upsert search documents from canonical parsed data.
_Avoid_: indexing directly inside webhook request, trusting webhook payload content, synchronous Typesense writes in the webhook, updating search while leaving stale dictionary cache

**Dictionary Typesense Upsert**:
A dictionary-specific indexing helper that maps the parsed AI Coding Dictionary into the existing `TypesenseResourceSchema` shape and writes to the shared AI Hero content collection. It should mirror existing Typesense behavior: create a `Typesense.Client` with `NEXT_PUBLIC_TYPESENSE_HOST` and `TYPESENSE_WRITE_API_KEY`, validate every document with `TypesenseResourceSchema`, write to `TYPESENSE_COLLECTION_NAME`, and bulk `import(documents, { action: 'upsert' })` for re-index jobs. A dictionary full re-index should delete only dictionary documents first, for example `type:=[dictionary,dictionary-entry]`, then upsert the current index page and entries. It must not use the existing full rebuild delete of `visibility:public`, because that deletes unrelated public content. It should not reuse `upsertPostToTypeSense`, because dictionary pages are GitHub-derived pages, not CourseBuilder `ContentResource` records with tags, parent resources, and post actions. Build-time/manual indexing and webhook-triggered indexing should call the same helper. The webhook endpoint should send an Inngest event and return quickly; the Inngest function should revalidate the dictionary cache tag and call the shared helper. Manual/build-time backfills can call the shared helper directly without round-tripping through Inngest.
_Avoid_: forcing dictionary entries through `ContentResource`, mixing CourseBuilder post assumptions into dictionary indexing, separate build-time and webhook mappers, broad deletes

**Cohort**:
A scheduled, time-bound group learning experience with live sessions. Lives under `/cohorts/*`.
_Avoid_: bootcamp, class

**Event**:
A one-off live session, workshop, talk, or demo. Lives under `/events/*`.
_Avoid_: webinar, session

**Live**:
The umbrella term for time-bound experiences (cohorts + events). Used as a primary nav heading.
_Avoid_: scheduled, upcoming

### Commerce and access

**Purchase Benefit**:
A non-primary benefit attached to a specific purchase or quote that grants extra access or value without changing the purchased product or discount.
_Avoid_: discount, free product, hidden bundle, sweetener

**Purchase Benefit Transport**:
The Course Builder commerce convention for a versioned compact JSON string stored in Stripe metadata under `purchaseBenefits` so operator-created quotes and invoices can carry benefit intent until app-owned purchase records exist.
_Avoid_: full JSON blob, preset, flat numbered metadata keys

**Purchase Benefit Entitlement**:
An entitlement created from a Purchase Benefit for a buyer or redeemed team seat.
_Avoid_: normal product entitlement when the source is a benefit rule

**Team Seat Redemption**:
The fact emitted by the redemption creation path when a learner has claimed one seat from a team purchase.
_Avoid_: bulk coupon redemption when speaking to operators

**Redeemed Seat Purchase**:
A zero-dollar purchase record used by the current implementation to represent a Team Seat Redemption.
_Avoid_: calling a redemption a purchase in operator-facing language

**Team Seat Redemption Followup**:
The redeemed team seat lane for every redeemed bulk purchase that reacts to `team-seat-redemption/created`, applies Purchase Benefits when present, and sends one combined welcome email for the learner.
_Avoid_: bulk coupon followup, team learner onboarding, redeemed seat side effects

**Team Sale**:
The end-to-end operator workflow for converting a team inquiry into a quote, invoice, Purchase Benefits, verified fulfillment, and support follow-up.
_Avoid_: manual invoice when the deal includes team seats, benefits, or redemption followup

**Stripe Quote Command**:
A provider-level `skill stripe quotes` CLI action that creates or verifies Stripe quotes with app-specific metadata such as Purchase Benefit Transport.
_Avoid_: team sale command, Front command, app-owned fulfillment command

**Agentic Commerce**:
The public AI Hero feature name for agent-compatible purchasing, where compatible agents can quote eligible products, pay with agent-granted payment credentials, receive a Claim Token, and optionally redeem it for a claimant.
_Avoid_: Shared Payment Token Checkout as the public feature name, Claim Token Checkout as the feature name, replacing Checkout

**Agentic Commerce Experiment**:
An AI Hero-owned commerce experiment that proves Agentic Commerce through a bounded single-seat purchase path while preserving a later evidence-based promotion path into Course Builder core after live usage, support recovery, and cross-app or volume pressure justify extraction.
_Avoid_: core commerce primitive before the Stripe preview is proven, replacing Checkout, generic agent checkout, promoting only because v0 works once

**Agentic Single-Seat Purchase**:
A one-recipient AI Hero purchase paid through an agent-granted payment credential, limited to one product and one entitlement recipient in the first experiment.
_Avoid_: team sale, subscription, bulk purchase, Purchase Benefit path

**Agentic Delivery Email**:
An optional email address used only when an agent explicitly requests Claim Token instruction delivery, not the app identity anchor or entitlement target.
_Avoid_: required recipient identity, deriving app identity from SPT billing email, entitlement email before claim, implicit email send just because an address is present

**Claimant Email**:
The email address supplied when a Claim Token is redeemed through either email-first browser redemption or agent API redemption, anchoring the app identity and entitlement target for the Agentic Redeemed Access Purchase.
_Avoid_: assuming it matches an intended recipient, purchaser email, SPT billing email

**Agentic Claim Redemption**:
The redemption path for a Claim Token, supporting both email-first browser redemption and direct rate-limited `/api/agentic-commerce/claims` redemption with a Claimant Email, where bearer token possession is sufficient authority in v0.
_Avoid_: payment at redemption time, requiring the original purchase agent to redeem, browser-only redemption as the permanent boundary, claimant delegation proof in v0

**SPT Billing Details**:
Payment-method metadata exposed by Stripe for a Shared Payment Token, useful for payment receipts and support but not authoritative for AI Hero app identity.
_Avoid_: recipient identity, account owner, entitlement email

**Agentic Eligible Product**:
Any active AI Hero one-time product whose final amount can be computed server-side and whose fulfillment can be represented by a One-Seat Bulk Coupon and Claim Token.
_Avoid_: explicit launch-only allowlist, subscriptions, products requiring address-based tax calculation, products without redemption-compatible fulfillment

**Agentic Offer Quote**:
A stateless, read-only, rate-limited AI Hero response from `/api/agentic-commerce/offers/:productId` for an Agentic Eligible Product that tells an agent the current server-computed product amount, currency, price identity, applied public coupon when present, and instructions needed to request an exact Shared Payment Token.
_Avoid_: stateful reservation in v0, quote ID requirement, agent price scraping, hardcoded amount

**Agentic Public Coupon**:
A valid non-team AI Hero coupon code an agent may submit during Agentic Offer Quote calculation so the exact Shared Payment Token amount matches the discounted server-computed price.
_Avoid_: bulk coupon, team coupon, Purchase Benefit coupon, PPP regional pricing in v0, discount stacking, applying a coupon only after payment

**Public Agentic Checkout Endpoint**:
The rate-limited `/api/agentic-commerce/purchases` endpoint intended for arbitrary compatible agents to create Agentic Single-Seat Purchases by presenting a valid Shared Payment Token and required purchase facts.
_Avoid_: private operator-only spike, trusted-client checkout, hidden manual purchase path

**Agentic Purchase Facts**:
The required facts an agent must submit for a Public Agentic Checkout Endpoint request: Shared Payment Token, product, expected price, quantity of one, and an Agent Request ID.
_Avoid_: inferred product, required recipient identity before claim, variable quantity in v0

**Agent Request ID**:
The required caller-provided idempotency and support reference for an Agentic Single-Seat Purchase, combined with the Shared Payment Token ID to identify retries, reject conflicting purchase facts, and prevent more than one successful Agentic Commerce Order per SPT.
_Avoid_: optional retry reference, using caller identity as the idempotency key, creating multiple Claim Tokens for the same retry, reusing a consumed SPT for a second order

**Exact SPT Amount Match**:
The rule that a Shared Payment Token must grant exactly the server-computed purchase amount and currency for an Agentic Single-Seat Purchase.
_Avoid_: broader spend grant, greater-than-or-equal amount check, tax tolerance before tax is explicitly modeled

**Agentic Tax Boundary**:
The v0 rule that Agentic Single-Seat Purchases only support prices with a server-known final amount and do not perform address-based tax calculation inside the agentic path.
_Avoid_: collecting tax address in v0, variable tax tolerance, pretending direct PaymentIntents have Checkout tax behavior

**SPT Adapter**:
A narrow AI Hero integration boundary for Stripe Shared Payment Token preview API calls and PaymentIntent confirmation without requiring a Stripe Customer in v0, isolated from normal Checkout and invoice commerce code.
_Avoid_: leaking preview API casts through commerce code, replacing the standard Stripe client, waiting for stable SDK types before learning, requiring purchaser email only to create a Stripe Customer

**SPT Preflight Validation**:
The required SPT Adapter check that retrieves a Shared Payment Token before PaymentIntent confirmation and verifies activity, livemode, exact amount, currency, and auditable agent/payment metadata.
_Avoid_: letting PaymentIntent confirmation be the first validation, post-hoc-only token inspection, vague agentic payment errors

**SPT Deactivation Audit**:
The rule that Stripe Shared Payment Token deactivation events are recorded for audit when they match known tokens, but do not revoke Claim Tokens after payment succeeds.
_Avoid_: treating post-payment SPT revocation as product access revocation, ignoring matched token lifecycle events

**Agentic Purchase Receipt**:
The machine-readable success response returned to an agent after an Agentic Single-Seat Purchase succeeds, including purchase facts, the Claim Token, a product-specific `?coupon=` claim URL, and direct redemption instructions.
_Avoid_: hosted Checkout thank-you page as the primary result, human-only receipt, URL-only receipt, token-only receipt, context-free claim URL in v0

**Claim Token**:
A bearer-transferable, one-use, non-expiring Course Builder full-price coupon code created after an Agentic Single-Seat Purchase is paid, allowing whoever holds the code, including the recipient or their agent, to claim the product through the redemption flow without paying again.
_Avoid_: Stripe zero-dollar transaction, Stripe PromotionCode, new token ledger, purchase receipt by itself, payment credential, expiring coupon, recipient-locked coupon, discount when the purpose is access claim, app responsibility for who ultimately claims the token, raw token in ordinary logs

**Agentic Claim Instructions**:
The full machine-readable and human-readable instructions returned after an Agentic Single-Seat Purchase and optionally emailed only when Agentic Delivery Email and explicit send intent are provided, explaining bluntly that the Claim Token gives one person access, anyone with the token can redeem it, it can only be used once, and the holder can use the claim link or give the token to an agent.
_Avoid_: vague success message, assuming the original recipient must personally claim, hiding bearer-token consequences from the agent, implicit email send just because an address is present, legal slab

**Agentic Side-Effect Split**:
The rule that revenue and creator sale notifications happen when the Shared Payment Token payment succeeds, while learner welcome and access notifications always happen when the Claim Token is redeemed, including direct agent API redemption.
_Avoid_: learner welcome before claimant exists, delaying revenue recognition until redemption, silent API redemption without claimant access email

**Agentic Commerce Source Marker**:
A source metadata value on existing purchase and redemption events that distinguishes Agentic Paid Purchase Records and Claim Token redemptions from normal Checkout, invoice, and team-sale flows.
_Avoid_: inventing a parallel event stream before existing commerce events fail, analytics pollution, hiding agentic purchases inside team sales

**Agentic Refund Handling**:
The v0 rule that the normal AI Hero 30-day refund policy applies to Agentic Single-Seat Purchases, while access or Claim Token revocation after refund remains a support/manual operation.
_Avoid_: final-sale claim tokens, automatic access revocation before the workflow is proven

**Agentic Commerce Order**:
The durable app-owned record for a Public Agentic Checkout Endpoint attempt, storing idempotency, Agentic Purchase Machine state, purchase facts, Stripe PaymentIntent and SPT references, recovery status, and links to the Agentic Paid Purchase Record and Claim Token coupon, visible in a dedicated admin support page with narrow recovery actions for v0.
_Avoid_: Stripe metadata as the only state store, creating purchases before idempotency exists, hiding pending recovery in logs, DB-only support workflow, full refund or reassignment console in v0

**Agentic Purchase Machine**:
The explicit purchase orchestration state machine for Agentic Single-Seat Purchases, with persisted states for received, quote_validated, spt_validated, payment_confirming, payment_succeeded, paid_purchase_created, claim_token_created, succeeded, rejected, payment_failed, payment_succeeded_token_pending, and needs_support.
_Avoid_: boolean soup around payment and token issuance, hiding recovery state in logs only, modeling retry counters as separate states

**Agentic Token Pending State**:
The recoverable state where a Shared Payment Token payment succeeded but post-payment Claim Token issuance did not complete, requiring durable retry or support recovery instead of pretending the purchase failed.
_Avoid_: losing paid orders, creating active Claim Tokens before payment, automatic refund as the only recovery path, non-idempotent token creation

**Agentic Paid Purchase Record**:
The paid purchase created in the same post-payment database transaction as its one-seat Claim Token, granting entitlement to that transferable token instead of directly to the eventual claimant.
_Avoid_: redeemed access purchase, direct product entitlement to the eventual claimant, split non-transactional coupon and purchase creation

**Agentic Redeemed Access Purchase**:
The zero-dollar access purchase created when a Claim Token holder redeems the product, granting product entitlement to the claimant.
_Avoid_: original paid purchase, payment receipt, billing event

**One-Seat Bulk Coupon**:
A bulk-coupon-shaped purchase with exactly one redeemable seat, used when a paid purchase should create a transferable Claim Token before the final product claimant is known.
_Avoid_: ordinary discount coupon, multi-seat team sale, new token ledger

**Agentic Payment Metadata**:
Stripe PaymentIntent metadata that links an agentic payment to its flow version, Agent Request ID, product, price, amount, applied Agentic Public Coupon, Shared Payment Token, Agentic Paid Purchase Record, Claim Token coupon, and recovery state.
_Avoid_: support-blind Stripe payments, DB-only linkage for disputes, unversioned metadata

**Agentic Claim Token Metadata**:
Coupon fields that mark a One-Seat Bulk Coupon as an agentic Claim Token and link it to the Agentic Paid Purchase Record, Shared Payment Token, PaymentIntent, agent request reference, applied Agentic Public Coupon, and source context.
_Avoid_: inferring agentic behavior only from maxUses, polluting team-sale analytics, untyped metadata junk drawer

**Duplicate Claim Block**:
The redemption rule that a Claim Token holder who already has a valid non-bulk purchase for the product cannot redeem the token for a duplicate access purchase, and the Claim Token remains unconsumed.
_Avoid_: duplicate valid purchases for the same claimant and product, consuming the token without access, automatic credit behavior in v0

## Relationships

- A **Purchase Benefit** belongs to exactly one purchase or quote decision.
- A **Purchase Benefit** may be supplied as versioned compact JSON in Stripe quote or invoice metadata during operator setup.
- A **Purchase Benefit** is copied into the original team purchase's bulk coupon for multi-seat purchases and into the purchase fields for single-seat purchases when the purchase is created.
- Invalid **Purchase Benefit Transport** should not block the primary purchase, but should create a review flag and alert support operations.
- Purchase Benefit telemetry should use a high-cardinality structured envelope with purchase benefit ID, purchase IDs, coupon ID, user identity, product ID, resource IDs, Stripe IDs, and Front conversation ID when available.
- Expanded Purchase Benefits store an ID so logs, Slack alerts, and retries can correlate the same benefit without recalculating identity.
- In v1, a **Purchase Benefit** applies either to redeemed team seats for a multi-seat purchase or to the buyer for a single-seat purchase.
- A **Purchase Benefit** may grant access to one or more resources for each redeemed team seat or to the buyer of a single-seat purchase.
- A multi-seat **Purchase Benefit** is applied only when a team seat is redeemed, not when the team purchase is paid.
- A single-seat **Purchase Benefit** is applied to the buyer after the purchase is created.
- Single-seat buyer benefits react to the factual event `purchase/benefits-attached`.
- A **Purchase Benefit** stores operator-authored business intent, such as access to a cohort resource, and workflows derive the concrete entitlements.
- A **Purchase Benefit** creates Purchase Benefit Entitlements for content access, not Discord role entitlements.
- A **Purchase Benefit Entitlement** is sourced to the operational purchase for undo and carries metadata identifying the Purchase Benefit that produced it.
- A **Purchase Benefit** may reference an optional bespoke welcome email content resource for the buyer or redeemed learner.
- Redeemed team seat followup has its own lane separate from individual purchase and team purchaser followup.
- In v1, existing post-purchase code still owns primary entitlement creation for Redeemed Seat Purchases while Team Seat Redemption Followup owns redeemed-seat email coordination and Purchase Benefits.
- In a later cleanup phase, primary redeemed-seat entitlements may move out of the generic post-purchase workflow into the Team Seat Redemption lane.
- A **Purchase Benefit** is applied by a separate Inngest function for redeemed team seats after the Team Seat Redemption fact is emitted.
- A **Purchase Benefit** welcome email is sent from the redeemed team seat followup lane after benefit entitlements are created and is guarded by a sent marker on the redeemed purchase fields.
- A redeemed team seat should receive one total welcome email whenever possible, combining primary seat access and Purchase Benefits instead of sending separate normal and benefit emails.
- A redeemed team seat receives at most one combined Purchase Benefit welcome email, even when multiple benefits are applied.
- Multiple distinct Purchase Benefit welcome email resources for the same redeemed seat are invalid metadata and require operator review.
- A **Purchase Benefit** creates entitlements sourced to the redeemed seat purchase so unregistering the seat removes both normal and benefit access.
- A **Seat Redemption** is unique per learner email and bulk coupon while the redeemed purchase is valid.
- A duplicate **Seat Redemption** must be blocked before creating a purchase or incrementing coupon usage.
- A **Purchase Benefit** does not change the purchased product or the price calculation.

### Subscriber marketing automation

**Subscriber Marketing Automation**:
The AI Hero domain that turns contact events into durable marketing state and bounded next actions.
_Avoid_: Kit Automation, CRM, automation engine when speaking about the domain boundary

**Contact**:
A polymorphic interface over external identities that allows AI Hero to look up, correlate, and capture state machine activity for an addressable person or organization touchpoint.
_Avoid_: subscriber when referring to the cross-provider identity, user when no app account is required

**Provider Identity**:
A provider-specific identity attached to a **Contact**, uniquely identified by provider and external ID when available.
_Avoid_: contact when referring to the provider-specific ID itself

**Email Identity**:
A **Provider Identity** using a normalized email address as its external ID.
_Avoid_: treating email as proof that two conflicting contacts are the same person

**Provisional Contact**:
A **Contact** created from weak identity evidence, such as an email-only event, before stronger provider identity or user correlation is known.
_Avoid_: merged contact, confirmed user

**Contact State**:
The durable marketing state machine state attached to exactly one **Contact**.
_Avoid_: user state when referring to marketing automation, subscriber state

**Contact Lifecycle**:
The coarse status inside **Contact State** used to decide whether outbound automation is eligible.
_Avoid_: provider status, Kit subscription status

**Contact Event**:
An immutable normalized event addressed to exactly one **Contact** and safe for the **Workflow Brain** to process.
_Avoid_: raw webhook, provider payload, normalized marketing event

**Raw Provider Payload**:
The original provider payload or provider reference captured before normalization, stored separately from a **Contact Event**.
_Avoid_: contact event when the data is still provider-shaped

**State Transition**:
An immutable record of applying one **Contact Event** to one prior **Contact State** to produce a new **Contact State** and bounded intents.
_Avoid_: log line, analytics event

**Durable Truth**:
The MySQL-owned record of Contacts, Provider Identities, Contact Events, Contact State, State Transitions, Next Actions, and side-effect intents.
_Avoid_: Redis truth, Axiom truth, spreadsheet source of truth

**Safe Marketing Field**:
A bounded label, boolean, CTA key, or safe summary that may be synced to Kit or reporting outputs.
_Avoid_: raw reply text, unrestricted provider payload, personal support details

**Shadow Field**:
A Kit custom field synced for observability, segmentation review, or dry-run comparison that is not read by any live customer-facing surface.
_Avoid_: hidden live personalization, rendered CTA field

**AI Hero Kit Field**:
An AI Hero-owned Kit custom field prefixed with `aih_` that stores stable slugs or safe computed values.
_Avoid_: unprefixed field, human label as durable Kit value

**Human Review Flag**:
A hard-stop state marker that prevents outbound marketing automation until an operator reviews the contact context.
_Avoid_: soft hint, low-priority label

**Operator Control Plan**:
The review-gated plan, milestones, and operating context maintained in the AI Hero support cockpit repo and chat workflow for human-directed rollout.
_Avoid_: fully autonomous launch plan, unattended automation

**Customer Send Decision**:
Any initial decision that could cause a customer to receive an email, support reply, sequence message, CTA-bearing message, or other outbound communication.
_Avoid_: treating sequence enrollment or CTA sync as purely technical

**Send Gate**:
A rollout checkpoint that limits customer-visible effects until the operator approves the next level of exposure.
_Avoid_: hidden launch, silent enablement

**Allowlisted Test Segment**:
A small operator-approved set of real Contacts, Kit subscribers, and email addresses used to test a customer-visible path at Send Gate D before broader rollout. The first Skills Workflow Gate D Allowlisted Test Segment targets 15 to 20 approved users when enough clean Recent Skills QQ Candidates exist, with explicit override allowed for fewer.
_Avoid_: public segment, launch audience, broad enrollment

**Recent Skills QQ Candidate**:
A Contact eligible for first-review Gate D consideration because they joined the Skills update form in the last 14 days and also answered the quick-question email.
_Avoid_: generic skills subscriber, broad segment, inferred prospect

**Daily Drip Progression**:
A Send Gate D fallback that moves an allowlisted Gate D Contact to the next Skills Workflow email on the next local day when they do not click, so the path completes even when the Contact does not answer.
_Avoid_: manual Kit fiddling, pre-seeding later sequences, exact 24-hour guarantee, hidden drip

**Local Day Drip Schedule**:
A rough next-day 9 AM local send schedule derived from a Contact's known or inferred local timezone, preferring browser IANA timezone evidence, using Vercel geo headers as fallback, and falling back to roughly 24 hours after enrollment when unavailable.
_Avoid_: exact delivery promise, account timezone when no account timezone exists

**Drip Progressed Event**:
A Contact Event recording that Daily Drip Progression advanced a Contact without an answer click.
_Avoid_: pretending a no-click drip is an answer-selected event

**Answer Selected Inngest Event**:
An Inngest event named `value-path/answer.selected` emitted after Durable Truth records an answer click, used to wake the matching Daily Drip Wait Run.
_Avoid_: replacing the Contact Event, sending before the durable click record exists

**Value Path Email Enrolled Event**:
An Inngest event named `value-path/email.enrolled` emitted after a value path Kit sequence enrollment succeeds, used to start the matching Daily Drip Wait Run.
_Avoid_: calling Kit enrollment delivery, replacing the Side Effect Intent receipt

**Daily Drip Wait Run**:
A per-Contact, per-sent-email Inngest run that waits for either an answer click event or a Local Day Drip Schedule timeout before exiting or creating Daily Drip Progression. It matches clicks by Contact ID, value path slug, and sent email resource ID.
_Avoid_: whole-path scheduler, global batch drip

**Default Drip Next Email**:
The next value path email selected by Daily Drip Progression when a Contact does not click the current email. It is derived from the value path ContentResource collection ordering, using `contentResourceResource.position`, not from ad hoc scheduler logic.
_Avoid_: synthetic answer, fake route, hidden branch decision

**Gate D Candidate Preview**:
A read-only operator preview that proposes Recent Skills QQ Candidates for an Allowlisted Test Segment without enrolling anyone or writing provider state.
_Avoid_: audience enrollment, Kit segment, broad rollout

**Gate D Runtime Allowlist**:
A disposable Redis-backed control object that names which Contacts, Kit subscribers, emails, value paths, email resources, and Kit sequences are allowed to progress during a specific Gate D activation. For the first Skills Workflow activation, this should be one small JSON object rather than separate Redis sets.
_Avoid_: Contact State, permanent audience segment, broad rollout list

**Candidate Rationale**:
A bounded operator-facing explanation for why a Contact appears eligible for a Gate D Candidate Preview, including source evidence and blockers without raw QQ text.
_Avoid_: raw reply dump, customer-facing personalization copy

**Operator Action Preview**:
A read-only, internal preview that translates current **Contact State** and **Shadow Fields** into auditable operator recommendations without creating customer-visible effects.
_Avoid_: Send Gate D, sequence enrollment, rendered CTA

**Next Action**:
A bounded domain recommendation computed for exactly one **Contact**, using linked **User** context as safety and eligibility input.
_Avoid_: provider API call, user action when the action is channel-specific, arbitrary automation path

**Side Effect Intent**:
A durable execution request derived from a **Next Action** and executed by a **Channel Adapter** only after gates and safety checks pass.
_Avoid_: next action when the item is provider-specific work

**User**:
An AI Hero app account that serves as the preferred correlation point for one or more **Contacts**.
_Avoid_: subscriber, contact

**Contact Link**:
An association between a **Contact** and a **User** used for lookup, support context, and understanding how external identities are connected.
_Avoid_: merge when the contact state remains separate

**User Rollup Context**:
Cross-contact context derived from the linked **User**, including entitlements, purchases, and support state used for safety and eligibility.
_Avoid_: contact state when the fact belongs across linked contacts

**Offer Catalog**:
The curated hybrid set of sellable AI Hero offers that the **Intent Planner** is allowed to reference.
_Avoid_: ad hoc CTA list, hardcoded product pitch, non-sellable value path, assuming every offer is a database product

**Offer Catalog Review**:
An operator review of offer status, eligibility, CTA keys, pitchability, and customer entitlement mapping before offers can drive customer-visible actions.
_Avoid_: silent product launch, automatic pitch enablement

**Offer Catalog Gardening**:
Ongoing operator maintenance of the **Offer Catalog**, including new product additions, closed offer updates, copy changes, eligibility changes, catalog sync, and invalidation.
_Avoid_: one-time setup

**Evergreen Sequence**:
A long-lived nurturing path that educates or orients a contact before a bridge or offer decision.
_Avoid_: one-off broadcast, direct pitch

**Bridge**:
A transitional path that prepares a contact for an upcoming offer decision without surprising them with a pitch.
_Avoid_: abrupt sales email, hidden pitch switch

**Offer**:
A sellable next step from the **Offer Catalog**, such as a product, cohort, paid consultation, team package, or future paid offer.
_Avoid_: free resource, customer education path, general benefit, value path

**Value Path**:
A non-sellable path that delivers education, orientation, support, or useful resources without directly asking for a purchase.
_Avoid_: offer when nothing is for sale

**Value Path Blueprint**:
An operator-approved design for a specific **Value Path** that defines the person's present state, trigger, milestones, proof of progress, target state, next path, source corpus, trusted external resources, telemetry plan, and safety notes.
_Avoid_: generic nurture list, one-size-fits-all newsletter, offer sequence, topic outline, AI Hero-only content assumption

**Value Path Telemetry**:
The product analytics, attribution, traffic, content, survey, reply, and operator-review signals used to judge whether a **Value Path** is moving people toward its target state.
_Avoid_: vanity metrics, click tracking only, revenue-only reporting

**Path Page**:
A user-aware but non-sensitive website page for a **Value Path** milestone that explains the step, curates approved resources, and asks for the milestone proof artifact.
_Avoid_: generic blog post, private account page, email-only lesson

**Path Token**:
A signed link token that correlates a **Path Page** visit or artifact submission to a **Contact**, subscriber, **User**, path, and milestone when available, without requiring login.
_Avoid_: password, bearer token for private data, sensitive payload

**Path Skill**:
An agent-consumable companion skill for a **Value Path** that helps the subscriber's coding agent follow the path, use approved resources, inspect local project progress, and produce milestone artifacts.
_Avoid_: human-only worksheet, generic prompt pack, unreviewed agent instructions

**Enter Value Path**:
A v1 **Next Action** that moves a **Contact** into a reviewed non-sellable education or nurture path.
_Avoid_: start track, pitch offer

**Benefit**:
A promised outcome or reason a contact might care about a **Value Path** or **Offer**.
_Avoid_: offer, action

**Sequence Stack**:
The operator-reviewed structure that can connect an **Evergreen Sequence** to a **Bridge** to an **Offer**.
_Avoid_: unbounded automation graph

**Workflow Brain**:
The AI Hero-owned decision layer that maintains marketing state and chooses bounded next actions.
_Avoid_: Kit Automations, Liquid logic

**Signal Classifier**:
A bounded classification step that turns normalized input into **Contact Signals** before the **State Reducer** runs.
_Avoid_: reducer, unbounded agent decision

**Contact Signal**:
A bounded classification result with confidence and rationale, grounded in real quick-question taxonomy data.
_Avoid_: raw reply, arbitrary freeform segment, invented product-shaped bucket

**Why Signal**:
A **Contact Signal** that captures why the contact is interested, using the quick-question taxonomy.
_Avoid_: generic interest bucket

**Who Signal**:
A **Contact Signal** that captures who the contact appears to be, using the quick-question taxonomy.
_Avoid_: demographic persona when the evidence is behavioral or professional context

**Bucket**:
A stable grouping derived from Ask Method-style audience research, represented in v1 by **Why Signals** and **Who Signals**.
_Avoid_: prescription, persona when the grouping is based on response patterns

**Primary Bucket**:
The single bucket chosen for routing a **Contact** into a **Value Path**.
_Avoid_: all buckets, forced choice when confidence is low

**All Buckets**:
The full set of buckets detected for a **Contact Event** or **Contact**, used for reporting and future personalization.
_Avoid_: primary bucket

**Signal Slug**:
A stable code-facing identifier for a **Contact Signal** used in state, tests, and Kit fields.
_Avoid_: display label as database key

**Signal Label**:
A human-facing label for a **Contact Signal** used in operator tools and reports.
_Avoid_: code slug in customer or operator-facing prose when a clear label exists

**State Reducer**:
The pure part of the **Workflow Brain** that applies a **Contact Event** with **Contact Signals** to **Contact State** and emits a domain-level **Next Action**.
_Avoid_: adapter, Inngest function, Kit automation

**Intent Planner**:
The part of the **Workflow Brain** that turns approved **Next Actions** into **Side Effect Intents** after send gates, review flags, suppression, eligibility, and rollout mode checks.
_Avoid_: reducer, provider adapter

**Channel Adapter**:
A provider-specific boundary that normalizes external events and executes approved side effects without owning marketing decisions.
_Avoid_: integration when the boundary owns domain behavior

## Relationships

- **Primary nav** and **Footer nav** read from the same `useNavLinks()` source, Footer is the curated, flattened, past-omitting projection.
- **Wrangler** is footer-only. It has no analogue in the primary nav, by design.
- A **Course** is paid; a **Free Tutorial** is free. Both live under "Learn" in nav.
- The **AI Coding Dictionary** is a free reference surface and appears as a **Free Tutorial** item in Learn.
- A **Cohort** has multiple live sessions; an **Event** is a single live session. Both live under "Live" in nav.
- A **User** may have one or more **Contacts** through **Contact Links**.
- A **Contact** may be linked to zero or one **User**.
- AI Hero should try to correlate a Kit subscriber ID to a **User** whenever possible.
- A **Contact** has one or more **Provider Identities**.
- A **Provider Identity** belongs to exactly one **Contact** at a time.
- **Provider Identity** uniqueness is provider plus external ID where possible.
- An **Email Identity** can create a **Provisional Contact**, but should not automatically merge conflicting **Contacts**.
- Strong provider IDs, such as AI Hero user ID or Kit subscriber ID, provide higher-confidence correlation than email alone.
- A **Contact** has zero or more **Contact Events**.
- A **Contact Event** belongs to exactly one **Contact**.
- A **Contact Event** includes source, type, occurred time, contact ID, identity evidence, provider event reference, semantic idempotency key, payload summary, privacy level, and schema version.
- **Raw Provider Payloads** are separate from **Contact Events** and are optional.
- **Contact Events** store normalized summary fields and classification inputs, not unrestricted raw text by default.
- **Raw Provider Payloads** store provider references and minimal raw payload only when needed for audit or debugging with restricted access.
- **Safe Marketing Fields** are the only values synced to Kit or reporting outputs.
- A **Shadow Field** stops being a **Shadow Field** when any live email, snippet, broadcast, sequence, automation, or customer-facing surface reads it.
- Activating a former **Shadow Field** in a customer-facing surface requires **Send Gate** D approval.
- **AI Hero Kit Fields** use the `aih_` prefix.
- **AI Hero Kit Fields** store stable slugs as values by default.
- **Signal Labels** stay in Durable Truth and operator UI unless a rendered snippet explicitly needs them.
- **Operator Action Preview** sits between **Send Gate** C and **Send Gate** D, and does not render CTAs, send email, enroll sequences, write Front, or write Contact State.
- An **Allowlisted Test Segment** may include real subscribers, but only through explicit Contact ID, Kit subscriber ID, and email allowlists.
- The first Skills Workflow **Allowlisted Test Segment** should target 15 to 20 approved users when the **Gate D Candidate Preview** finds enough clean candidates, with explicit operator override allowed for fewer.
- A **Recent Skills QQ Candidate** must have both Skills form interest evidence and a captured quick-question reply before being considered for a first real Gate D allowlist.
- First real Gate D candidate selection excludes Contacts with hard send-gate blockers and excludes quick-question replies that indicate team sales or support intent.
- Minimum Gate C **Shadow Fields** are `aih_why_primary`, `aih_who_primary`, `aih_confidence`, `aih_human_review`, `aih_review_reason`, `aih_last_signal_at`, `aih_contact_state`, and `aih_next_action`.
- CTA fields are not part of the minimum Gate C **Shadow Fields** unless reviewed as customer-send-adjacent fields.
- Axiom receives operational metadata, not raw customer messages.
- Google Sheets and CSV exports remain sanitized reporting outputs.
- **Durable Truth** lives in MySQL.
- Redis may hold ephemeral dedupe windows, locks, rate limits, short-lived queues, and disposable runtime gate configuration, but does not own durable marketing state.
- A **Gate D Runtime Allowlist** may live in Redis because it is temporary rollout configuration, not **Durable Truth** for the Contact.
- Axiom may mirror observability logs, but does not own durable marketing state.
- A **Contact** has exactly one current **Contact State**.
- v1 **Contact Lifecycle** values are new, classified, nurture ready, human review, suppressed, customer, and stale.
- Human review and suppressed lifecycles block outbound automation.
- Customer lifecycle suppresses purchase CTAs and may allow customer education CTAs later.
- Stale lifecycle requires recomputation or operator review before customer-visible sends.
- A **Contact** has zero or one current **Next Action**.
- v1 **Next Actions** are do nothing, human review, set shadow fields, recommend resource, enter value path, and ask follow-up.
- Set shadow fields is allowed at **Send Gate** C only when fields are not rendered to customers.
- Recommend resource, enter value path, and ask follow-up become **Customer Send Decisions** before they affect customers.
- In v1, ask follow-up creates a human-reviewable suggested follow-up question and never auto-sends.
- AI Hero surveys can be created and managed through `aihero-cli`, making customized per-contact surveys a plausible later follow-up mechanism after operator review.
- If a contact replies to an approved follow-up or survey, that response becomes a new **Contact Event** and may resolve the **Primary Bucket**.
- In v1, recommend resource produces a suggested resource in **Contact State** and operator lookup, not an automatic send.
- At **Send Gate** C, recommend resource may sync a non-rendered shadow field such as `aih_next_resource`.
- At **Send Gate** D, using a recommended resource in rendered email or snippets requires operator approval of resource, copy, and audience.
- A **Side Effect Intent** is provider-specific or execution-level, such as sync Kit fields, enroll in Kit sequence, apply Front tag, or create review item.
- **Channel Adapters** execute **Side Effect Intents**, not **Next Actions** directly.
- Normal reads use current **Contact State** from **Durable Truth** rather than rebuilding from all events.
- **Contact Events** and **State Transitions** support selected replay for dry-run, migrations, audits, and classifier changes.
- A **User** provides **User Rollup Context**, but does not own the primary marketing state machine.
- Purchase and entitlement facts are **User Rollup Context**.
- When any linked contact or user has an active entitlement for an offer, the **Intent Planner** suppresses purchase CTAs for that offer across linked **Contacts**.
- Active entitlement may still allow non-purchase customer education actions later.
- An **Offer** is always something for sale or a path toward something for sale.
- A **Value Path** is not an **Offer**.
- The **Offer Catalog** is hybrid because not every offer is a product in the app database.
- App product, cohort, and entitlement records provide source facts where they exist.
- Operator-reviewed marketing overlays provide pitchable status, CTA keys, copy angle, send gates, and review notes.
- The **Intent Planner** can only choose offer CTAs from the reviewed **Offer Catalog**.
- **Offer Catalog Review** is required before new products, cohorts, waitlists, or customer-visible offer CTAs become eligible.
- **Offer Catalog Gardening** keeps closed cohorts from being pitched and invalidates stale offer state when product status changes.
- A **Sequence Stack** may connect an **Evergreen Sequence** to a **Bridge** to an **Offer**.
- A **Value Path Blueprint** must exist before a **Value Path** is implemented as a Kit sequence or surfaced in **Operator Action Preview**.
- A **Value Path Blueprint** may curate trusted external resources alongside AI Hero-owned corpus material when those resources better move the person toward the target state.
- Trusted external resources have an extremely high bar: canonical docs, official lab/reference projects, trusted friends, proven working examples, or practitioners whose taste AI Hero would actively vouch for. Matt must approve every external resource before it becomes subscriber-facing. Slop factory posts, generic listicles, stale examples, hype threads, and rabbit holes without proof artifacts are excluded.
- A **Value Path Blueprint** needs **Value Path Telemetry** for every subscriber-facing resource, email, worksheet, or step so operators can see what helps, what stalls, and what should be removed.
- **Value Path Telemetry** should use AI Hero product analytics surfaces where available, including revenue, attribution coverage, traffic, YouTube content performance, surveys, and traffic-to-revenue correlation. YouTube analytics are useful for content correlation but lag by about 48 hours.
- **Path Pages** should avoid sensitive content by default. A **Path Token** can correlate progress from email links, while cookies and logged-in **User** identity can strengthen correlation when available.
- **Path Tokens** may record non-sensitive progress and artifact submissions, but sensitive or account-specific data requires normal authentication.
- Every implementation-ready **Value Path Blueprint** must be agent-first: define a **Path Skill**, machine-readable path content, and agent-ready resources so subscribers can work through the path with their own coding agent.
- A minimal **Path Skill** is required for v1 launch of any subscriber-facing **Value Path**. No **Path Skill**, no subscriber-facing **Value Path**.
- **Path Skills** should follow the companion-skill pattern from trusted examples such as Vercel Academy skills: fetch or reference path content, detect local progress where possible, teach step-by-step, and evaluate milestone artifacts.
- Private **Value Path** content lives under the support repo root `value-paths/` directory, starting with `value-paths/ship-your-first-ai-feature/` for the machine-readable path spec and worksheet shape.
- Private v1 **Path Skills** live under the support repo root `skills/` directory, starting with `skills/ship-your-first-ai-feature/SKILL.md`. The skill is an accessory to the path folder, so it models eventual subscriber distribution while staying private.
- For AIH-126, private path artifacts only need to prove the shape before blueprint approval. Do not overbuild full Path Page copy, resource detail, or expanded artifact systems before the blueprint is approved.
- Joel can approve the **Value Path Blueprint** shape for AIH-126 and **Gate C.5** internal preview use. Matt must approve every external resource before it becomes subscriber-facing.
- The first-pass individual learner **Value Path Blueprints** are **Ship Your First AI Feature**, **AI Coding Workflow for Real Engineering**, and **AI Fundamentals and Judgment**.
- The simple v1 path set should start with **Ship Your First AI Feature** and **AI Fundamentals and Judgment**, using existing shadow newsletter emails plus only a few simple glue emails where needed.
- Gate C.5 path previews should include the recommended path, match rationale, first anchor shadow-newsletter email, review blockers, and operator choices. Do not show the full candidate email sequence yet.
- A **Gate D Candidate Preview** is required before first real Skills Workflow activation and must not enroll Contacts or write Kit state.
- A **Gate D Candidate Preview** should show redacted identity, Contact ID, Kit subscriber ID when known, email domain, Candidate Rationale, and blockers.
- **Gate D Candidate Preview** domain logic belongs in the AI Hero app and may be exposed to operators through the support repo `bin/aih-sm` bridge.
- **Gate D Runtime Allowlist** can be written through an explicit operator command and read by `/ask`, Daily Drip Wait Runs, and the value path email executor.
- The first Skills Workflow **Gate D Runtime Allowlist** should be stored as one small Redis JSON object so it is easy to preview, diff, write, rollback, and delete.
- The Redis shape should use an active pointer plus a versioned activation object, for example an active key that points to `skills-workflow:<activationId>` and a separate object for that activation.
- A versioned **Gate D Runtime Allowlist** object should include allowlists, allowed value paths, allowed email resources, allowed Kit sequence IDs, candidate-level schedule evidence, operator metadata, status, and a `killSwitch` boolean.
- A **Gate D Runtime Allowlist** may store both normalized emails and normalized email hashes for runtime matching, while normal operator output redacts raw emails.
- **Gate D Runtime Allowlist** statuses are draft, approved, active, paused, and rolled_back. `killSwitch: true` is not a status. It overrides every status and forces Gate D reads to fail closed.
- For the first Skills Workflow activation, one explicit operator command may write an approved and active **Gate D Runtime Allowlist** after a clean dry-run preview.
- The first activation command may write the active **Gate D Runtime Allowlist** and enroll approved users into Skills Workflow Email 0.
- If the active **Gate D Runtime Allowlist** is missing, paused, rolled_back, or has `killSwitch: true`, `/ask`, Daily Drip Wait Runs, and the value path email executor fail closed and block progression or enrollment.
- Already-scheduled **Daily Drip Wait Runs** should wake normally, read the paused or blocked **Gate D Runtime Allowlist**, and exit blocked without sending.
- A **Gate D Runtime Allowlist** should not store per-Contact progress counters.
- Execution receipts still live in **Contact Events**, **Next Actions**, and **Side Effect Intents** even when the active allowlist itself lives in Redis.
- **Enter Value Path** is the v1 action for joining a non-sellable education or nurture path.
- In v1, **Primary Bucket** maps one-to-one to the matching **Value Path** by default only after the matching **Value Path Blueprint** is approved.
- For the Skills Workflow first Gate D activation, approved Contacts enter through Email 0 and self-select individual or team routing from that email rather than being pre-classified into one branch by the operator.
- **Skills Workflow Kit Sequence Set** is the fourteen one-email Kit sequences used as delivery primitives for the Skills Workflow value path: seven individual sequences and seven team sequences. These are not fourteen independent marketing campaigns and not one normal Kit drip sequence.
- The app controls whole value path progression. Kit sequences are the implementation surface for sending one value path email to one Contact at the moment the app decides that step is allowed.
- Enrolling a Contact into `AIH Skills Workflow, Individual, email-0` sends only Email 0. It does not automatically enroll them into the whole value path. Whole path delivery means the app later enrolls the same allowlisted Contact into the next one-email Kit sequence after click or daily drip progression passes Send Gate D.
- Do not enroll a Contact into all fourteen Skills Workflow Kit sequences at once. That bypasses branch choice, ordering, Daily Drip Wait Runs, Send Gate D checks, and durable progress receipts.
- **Daily Drip Progression** is allowed only on the next local day without a click, only for an allowlisted Gate D Contact, only through the Inngest progression rig with durable receipts, and must still pass **Send Gate** D before each next email.
- **Daily Drip Progression** uses a **Local Day Drip Schedule** rather than promising an exact 24-hour delay.
- Timezone evidence for **Local Day Drip Schedule** prefers browser IANA timezone, then Vercel geo headers, then roughly 24 hours after enrollment.
- Candidate-level schedule evidence may live in the **Gate D Runtime Allowlist**, and observed request timezone or geo evidence may be recorded in **Contact Event** metadata when available.
- When timezone evidence is available, the **Local Day Drip Schedule** targets roughly 9 AM local the next day.
- If the next 9 AM local fallback is less than 18 hours away from the triggering enrollment or click, skip to the following 9 AM local window.
- **Local Day Drip Schedule** should not create a permanent Contact State field or Kit custom field in v1.
- When no timezone or usable location evidence is available, the **Local Day Drip Schedule** falls back to roughly 24 hours after enrollment.
- For Email 0, **Default Drip Next Email** is individual Email 1.
- For later emails, **Default Drip Next Email** is the next email in the same selected branch by value path collection position.
- **Default Drip Next Email** lookup should use the imported ContentResource relation ordering, not a hardcoded scheduler map.
- For the first real Gate D activation, an allowlisted Contact may complete the full seven-email Skills Workflow path by clicks, daily drip, or a mix of both.
- A click before the daily fallback wins, emits an **Answer Selected Inngest Event**, wakes the waiting Inngest run, and causes that waiting run to exit without waiting for the full day.
- The click path owns clicked progression and creates the next `send-value-path-email` **Side Effect Intent** immediately.
- Each **Daily Drip Wait Run** tracks exactly one sent email for one Contact.
- A **Daily Drip Wait Run** matches **Answer Selected Inngest Events** by Contact ID, value path slug, and sent email resource ID.
- A **Daily Drip Wait Run** starts from a **Value Path Email Enrolled Event** after every successful value-path Kit sequence enrollment, including Email 0 and later path emails.
- Terminal Email 6 does not start a **Daily Drip Wait Run** because there is no next path email to send.
- Before Daily no-click advancement creates a new intent, it checks **Durable Truth** for an answer click or existing next-email intent for the same Contact and sent email.
- Daily no-click advancement records a **Drip Progressed Event**, then creates the same `advance-value-path` **Next Action** and `send-value-path-email` **Side Effect Intent** shape as click progression.
- **Enter Value Path** is blocked by human review, suppression, stale contact state, active customer purchase or entitlement conflicts, and unapproved **Send Gates**.
- Value path research from the egghead Roam graph includes lead magnets fed by free resources, collect and clarify before workshop deeper dives, segmented shadow newsletters, and site-behavior-triggered educational follow-up.
- **Bridges** exist so pitches are expected, contextual, and review-gated rather than abrupt.
- **Offers** may be products, cohorts, paid consultations, team packages, waitlists for future paid offers, or other sellable next steps.
- **Value Paths** and **Benefits** are differentiated from **Offers**.
- **Next Actions** are computed per **Contact**, not per **User**.
- When a **Human Review Flag** is set, allowed side effects are limited to persistence, human review queue updates, optional review/suppression flag sync, and support/operator lookup visibility.
- When a **Human Review Flag** is set, CTA sync, sequence enrollment, nurture actions, personal reply sending, and other outbound **Next Actions** are blocked.
- **Operator Control Plan** milestones are review-gated from the AI Hero support cockpit repo and chat context rather than treated as unattended automation.
- Every initial **Customer Send Decision** is operator-reviewed before activation.
- Sequence enrollment, CTA field sync that affects email rendering, support reply sending, and marketing email sends are **Customer Send Decisions**.
- **Send Gate** A is Contact State dry-run with no customer-visible effects.
- **Send Gate** B is internal-only capture from real Front or Kit events with no Kit writes and no customer-visible effects.
- **Send Gate** C is Kit field sync to non-rendered shadow fields only, with operator-reviewed diffs first.
- **Operator Action Preview** is the Gate C.5 planning surface that reads state and shadow fields to propose internal operator actions before any customer-visible test.
- **Operator Action Preview** should not route a **Contact** into a **Value Path** unless the matching **Value Path Blueprint** is approved.
- **Send Gate** D is rendered CTA, snippet, or sequence enrollment for a tiny allowlisted test segment only, with operator-approved copy and audience.
- **Send Gate** E is broader rollout after operator review of metrics, failures, and examples.
- **Subscriber Marketing Automation** uses **Channel Adapters** for Kit, Front, site behavior, purchase, app, and future providers.
- **Workflow Brain** belongs to **Subscriber Marketing Automation**, not to Kit, Liquid snippets, Front, or Google Sheets.
- **Signal Classifier** runs before the **State Reducer** and does not create provider-specific work.
- **Contact Events** entering the **State Reducer** include bounded **Contact Signals** when classification is needed.
- v1 **Contact Signals** should use the reviewed quick-question taxonomy as the starting model, especially **Why Signal** and **Who Signal**.
- Gate A classifier keywords are seed heuristics for deterministic dry-run behavior, not corpus-derived customer language.
- Gate B calibration must derive or validate classifier keywords from sanitized quick-question responses before classification quality drives internal capture decisions.
- The operator-reviewed quick-question Google Sheet is the primary source of customer language for Gate B taxonomy calibration.
- Test fixtures for calibrated taxonomy should use sanitized Sheet export snapshots rather than invented phrases or live production data.
- Sanitized Sheet export snapshots should include response text, reviewed Why Signals, reviewed Who Signals, reviewed layered review signals, and operator notes for edge cases.
- The private AI Hero support repo owns the full sanitized Sheet export snapshots as operating context.
- The AI Hero app repo should only receive tiny anonymized fixtures or derived calibration artifacts needed for deterministic tests.
- Classifier-proposed labels may seed the sanitized Sheet review workflow, but operator-reviewed disagreements define the calibration ground truth.
- Disagreements requiring operator review include low confidence rows, rows with any human review signal, and rows where the operator edits a proposed label.
- Low confidence means classifier confidence below 0.80 for Gate B calibration and review workflows.
- Sanitized Sheet export snapshots should exclude personally identifying details and support-sensitive raw context that is not needed for calibration.
- Quick-question responses act like Deep Dive Survey input from the Ask Method.
- **Buckets** group contacts from real response patterns.
- A **Contact Event** may produce multiple **Buckets**.
- **Primary Bucket** is the one chosen for routing.
- **All Buckets** are retained for reporting and future personalization.
- Low-confidence or tied bucket choices should produce human review or ask follow-up instead of forcing a **Value Path**.
- **Value Path** is preferred over Ask Method "Prescription" for the non-sellable path that follows a bucket.
- **Contact Signals** store both **Signal Slugs** and **Signal Labels**.
- **Signal Slugs** are stable for code, tests, state, and Kit fields.
- **Signal Labels** are used for operator-facing displays and reports.
- v1 **Why Signals** include AI coding workflow and real engineering, agentic workflows and automation, professional relevance and team adoption, build products apps and prototypes, content research and knowledge work, cut through overwhelm and build judgment, AI fundamentals and under-the-hood understanding, and other or unclear.
- v1 **Who Signals** include professional software engineer, technical or team leader, educator/content/community builder, nontraditional or early technical learner, data/research/AI practitioner, founder/product builder, and unclear.
- Buying, team sales, support, partnership, sponsorship, emotional, ambiguous, and low-confidence signals are layered review signals rather than primary buckets.
- **State Reducer** does not call LLMs, classifiers, providers, read rollout gates, or create provider-specific work.
- **Intent Planner** creates **Side Effect Intents** from approved **Next Actions**.
- **Channel Adapters** do not choose marketing paths, they normalize events and execute side-effect intents.

## Example dialogue

> **Dev:** "Should the new `/api/openapi.json` endpoint go in the footer Resources column?"
> **Designer:** "There is no Resources column, that's the **Wrangler** column. And yes, OpenAPI is machine-readable, so it belongs there next to **`/llms.txt`**."

## Flagged ambiguities

- "Tutorial" was used loosely for both paid courses and free standalone resources, resolved: paid is **Course**, free is **Free Tutorial**. The two are visually and conceptually separate in primary nav.
- "Subscriber" was used as the cross-provider person concept. Resolved: use **Contact** for the polymorphic external identity interface, and reserve **User** for an app account.
- "Merge contacts" was used loosely for identity correlation. Resolved: v1 should link **Contacts** to a **User** through **Contact Links** rather than collapsing contact state automatically.
