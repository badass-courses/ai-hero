# AI Hero analytics reporting semantics

Updated: 2026-06-23

## Traffic range behavior

- `range=180d` is only for GA4 traffic surfaces.
- Non-GA4 analytics surfaces intentionally reject `180d` with `INVALID_RANGE_FOR_SURFACE`.
- The admin dashboard keeps the global range on `24h`, `7d`, `30d`, `90d`, and `all`, then fetches a separate 180 day traffic detail panel.

## Traffic percentage fields

GA4 traffic breakdown rows can include:

- `sessionPercent`, share inside that returned breakdown table.
- `trafficSessionPercent`, share of total GA4 traffic sessions for the queried period.

Example: screen resolutions are limited to the top rows. A resolution can show a high `sessionPercent` inside the table while having a lower `trafficSessionPercent` against all sessions.

## Attribution quality lanes

Attribution coverage can include quality lanes:

- `strong`, purchase-field UTM, shortlink, or paid click evidence.
- `medium`, recovered exact purchase match from the shortlink attribution table.
- `weak`, GA client ID or self-reported source without stronger campaign evidence.
- `unknown`, no usable attribution evidence for paid revenue.

Coverage is not the same thing as clean first-touch attribution. Keep the headline coverage rate for quick checks, but use quality lanes for decisions.

## GA4 conversion receipts

GA4 Measurement Protocol writes stay non-blocking. The helper returns a safe receipt with status, event names, event count, HTTP status, and failure reason when available.

Receipt status values:

- `sent`
- `skipped_missing_config`
- `failed`

The receipt must not include tokens, raw emails, or other secrets. GA4 is not the revenue source of truth. Revenue truth stays in the application database and purchase fields.

## Correlation wording

Traffic, YouTube, survey, and revenue overlays are correlation surfaces unless an experiment or durable path-level attribution proves causality. Use contribution or correlation language, not lift claims.
