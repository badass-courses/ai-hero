# C5 pricing runbook

Cohort 005 (`product-s00zs`) is priced in-process by front-desk's engine through Course Builder's authoritative-price hook. This page covers the switches and alerts an operator acts on. Prices and the policy live in front-desk, never here.

## Settings

- **`AIH_C5_PRICING_DISABLED`** is the kill switch. Any value but unset, empty or `false` closes C5 display, checkout and team invoices with a `closed` decision. C5 never falls back to the legacy price. It takes effect on the next deploy.
- **`AIH_C5_DECISION_CUTOVER_AT`** is the instant paid C5 purchases started saving their pricing decision (`Purchase.fields.c5Decision`), as ISO-8601.
  - A Crash Course credit is spent when anyone in its transfer chain holds, or ever held, an individual C5 purchase from before the cutover.
  - After the cutover only saved decisions count. A C5 purchase from after it with no saved decision holds credit use until it has one.
  - Unset or unreadable, any buyer whose chain has C5 history is held.

## Setting the cutover

**Never set the cutover early.** Set it to the time the deploy that saves decisions finished going live in production, or any time after.

- Later is safe. A purchase between the real start and a later cutover is read as before the cutover, so its chain's credit is spent. That can only cost a buyer their credit, never charge less than the decision.
- Earlier fails open. Real purchases from before saving began would be read as after the cutover. They have no saved decision, so their chains would hold, and once a decision is backfilled by hand they would read as unspent.
- Run the read-only credit review before launch, with the cutover you intend to set.

## Alerts

### `c5.purchase.decision_failed`: "C5 purchase decision was not saved"

The `c5-purchase-decision` Inngest function could not save a paid C5 purchase's decision after its retries.

- **Effect:** until the decision is saved, credit use is held for every Crash Course purchase whose transfer chain includes that purchase's holder. Those buyers see a held price and cannot check out C5. Nobody is charged a wrong amount.
- **Action:** find the cause in the failed run (Stripe session read, database write). Fix it, then rerun the failed run from the Inngest dashboard. The save writes one key with `JSON_SET`, so a rerun is safe.
- **Done when:** the purchase has `fields.c5Decision` with the checkout session id, and the affected buyers price again.

### `c5.purchase.duplicate`: "Duplicate C5 purchase flagged for refund"

A second individual C5 purchase by one buyer, or a credit spent twice, was paid. Fulfillment was not blocked.

- **Action:** decide the refund. The purchase carries `fields.c5DuplicateOf`.

## Holds that are not alerts

- **`restricted-holder`:** the buyer holds a region-restricted C5 purchase. There is no upgrade path; support upgrades the ticket. Their checkout lands on the regional-upgrade support page.
- **`quotes-unavailable-at-checkout`:** front-desk's binding quotes could not be read fresh, so checkout holds rather than charge the formula.
- **`policy-unavailable` or `facts-unavailable`:** front-desk's policy, or the buyer's facts, could not be read. The price holds.
