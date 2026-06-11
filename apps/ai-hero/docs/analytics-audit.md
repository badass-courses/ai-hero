# AI Hero Analytics Audit

**Date**: 2026-03-22 (revised after codex review)
**Scope**: `apps/ai-hero/` in course-builder monorepo
**Primary goal**: Correlation & attribution — can we trace effort → outcome?

---

## Executive Summary

AI Hero has **four independent data silos** that cannot currently talk to each other:

1. **GA4** (browser sessions, traffic sources, pageviews)
2. **@skillrecordings/analytics track()** (custom events → GA4 + ahoy + fbq)
3. **Database** (purchases, shortlink clicks, attribution, progress)
4. **Mux Data** (video engagement, viewer plans, content types)

The shortlink attribution chain (shortlink click → `sl_ref` cookie → signup/purchase → `ShortlinkAttribution` row) is the **only working end-to-end attribution path**. Everything else is a dead end: GA4 sessions can't be joined to purchases, organic/direct traffic has zero attribution, UTM parameters are never captured, and the GA4 Data API is imported but the traffic surfaces are registered as valid routes but have **no implementation in the switch statement** — they'll throw "Unknown surface".

---

## Current Tracking Surface

### Client-Side Events

| Event | Source | Properties | Where |
|---|---|---|---|
| `video_completed` | track() | `video_id`, `video_title` | `post-player.tsx` (onEnded) |
| `completed: video` | track() | `resourceSlug`, `resourceType`, `moduleSlug`, `moduleType`, `bingeMode` | `authed-video-player.tsx` (onEnded) |
| `Problem Prompt Copied` | track() | `lessonId` | `copy-problem-prompt-button.tsx` |
| `waitlist_joined` | track() | `productId`, `productName` | workshop/cohort/event pricing widgets (×4 call sites) |
| `subscribed` | track() | `{}` (empty by default) | `post-video-subscribe-form.tsx`, `primary-newsletter-cta.tsx`, `video-block-newsletter-cta.tsx` |
| `share_content` | track() | `url`, `method` | `share.tsx` |
| `navigation_menu_item_click` | track() | `label`, `href`, `section` | `navigation/index.tsx` (×8 call sites) |
| `nav-link-clicked` | track() | `label`, `href` | `nav-link-item.tsx` |
| `clicked_link` | track() | `href`, `title` | `mdx-components.tsx` (external links in MDX) |
| `post_created` | track() | `slug` | `list-resources-edit.tsx` |
| `create_post_button_clicked` | track() | `listId` | `list-resources-edit.tsx` |
| `resource_creation_attempt` | track() | `resourceType` | `new-resource-with-video-form.tsx` |
| `resource_creation_validation_error` | track() | `resourceType`, `field` | `new-resource-with-video-form.tsx` (×2) |
| `create_top_level_resource` | track() | `resourceType`, `title` | `new-resource-with-video-form.tsx` |
| `create_post` | track() | `title` | `new-resource-with-video-form.tsx` |
| `resource_creation_failed` | track() | `error` | `new-resource-with-video-form.tsx` |
| `resource_creation_success` | track() | `resourceId`, `resourceType` | `new-resource-with-video-form.tsx` |
| `resource_creation_error` | track() | `error` | `new-resource-with-video-form.tsx` |
| GA4 enhanced measurement | @next/third-parties `<GoogleAnalytics>` | auto: page_view, scroll, outbound click, site search, video engagement, file download | `layout.tsx` (production only) |
| Axiom Web Vitals | `<AxiomWebVitals />` | CLS, FID, LCP, FCP, TTFB | `layout.tsx` |

**How track() works under the hood** (`@skillrecordings/analytics`): Fires to **three** destinations simultaneously:
1. `window.ahoy.track(event, params)` — **ahoy is not installed/configured**. Dead endpoint.
2. `window.fbq('trackCustom', event, params)` — **Facebook Pixel is not installed**. Dead endpoint.
3. `window.gtag('event', action, params)` — **This is the only live destination.** Goes to GA4.

So `track()` is effectively just `gtag('event', ...)` with extra overhead and two dead branches.

### Server-Side Data

| Data Source | What it Captures | Retention | Query Access |
|---|---|---|---|
| `Purchase` table | id, userId, totalAmount, productId, country, couponId, status, ipAddress, city, state, merchantChargeId, createdAt, fields JSON | Permanent | Drizzle ORM, `/api/analytics` |
| `ShortlinkClick` table | shortlinkId, timestamp, referrer, userAgent, country, device | Permanent | Drizzle ORM, `/api/analytics?surface=attribution/shortlinks` |
| `ShortlinkAttribution` table | shortlinkId, userId, email, type (signup\|purchase), metadata JSON, createdAt | Permanent | Drizzle ORM, `/api/analytics?surface=attribution` |
| `ResourceProgress` table | userId, resourceId, completedAt, updatedAt | Permanent | Drizzle ORM, tRPC `progress` router |
| `ContentResourceResource` table | parent→child resource relationships | Permanent | Drizzle ORM |
| Axiom (`ai-hero` dataset) | Structured request logs: path, method, status, duration, clientIp, userAgent, referer, requestId, Vercel metadata | ~30d (plan-dependent) | Axiom query API, Web Vitals dashboard |
| GA4 (property 468201826) | Sessions, users, pageviews, traffic sources, conversions | 14 months | GA4 Data API (configured but **refresh token missing**) |
| Mux Data | Video views, watch time, viewer engagement, buffering, errors | 90 days | Mux Data API, Mux dashboard |

### Mux Data Dimensions

| Dimension | Populated | Source Component | Notes |
|---|---|---|---|
| `video_id` | ~100% of players using `useMuxMetadata` | All players via hook | |
| `video_title` | ~100% | All players via hook | Falls back to resource ID if title missing |
| `viewer_user_id` | Authenticated viewers only | `useMuxMetadata` → `useSession` | Anonymous viewers = no user ID |
| `video_series` | **Workshop/tutorial paths only** | `authed-video-player.tsx` passes `moduleSlug` | Posts, MDX embeds, marketing = **not set** |
| `sub_property_id` (content type) | ~95% | All players pass `contentType` | Values: `post`, `lesson`, `marketing`, `mdx-embed` |
| `viewer_plan` (user role) | Authenticated viewers only | `useMuxMetadata` → `session.user.role` | Just shipped — accumulating data |

**MuxPlayer instances NOT using `useMuxMetadata`**: None found. All players (PostPlayer, AuthedVideoPlayer, LessonPlayer, MDXVideo, TrackedMuxPlayer) use the hook. ✅

**`video_series` gap**: `PostPlayer` and `MDXVideo` don't pass `videoSeries`. Only `AuthedVideoPlayer` (used in workshop/tutorial contexts) sets it to `moduleSlug`. This means standalone posts — likely the bulk of views — have no series dimension in Mux.

---

## Attribution Chain

```
                  ┌─────────────────────────────────────────────────────────────┐
                  │                    TRAFFIC SOURCES                          │
                  ├───────────────┬──────────────┬──────────────┬───────────────┤
                  │  Shortlink    │   Organic    │   Direct     │    UTM        │
                  │  /s/[slug]    │   (Google)   │   (bookmark) │   (?utm_...)  │
                  └───────┬───────┴──────┬───────┴──────┬───────┴───────┬───────┘
                          │              │              │               │
                   sl_ref cookie    GA4 session     GA4 session     GA4 session
                   (30-day TTL)    (no user ID)   (no user ID)   (NEVER CAPTURED)
                          │              │              │               │
                          ▼              ▼              ▼               ▼
              ┌──── SIGNUP ─────────────────────────────────────────────────────┐
              │                                                                 │
              │  ConvertKit form → subscribe-to-list endpoint                   │
              │                                                                 │
              │  IF sl_ref cookie exists:                                       │
              │    → ShortlinkAttribution (type: 'signup') ✅                   │
              │  ELSE:                                                          │
              │    → NOTHING. No attribution recorded. ❌                        │
              │                                                                 │
              │  User row created (createdAt) → USER_CREATED_EVENT              │
              │  No UTM, no referrer, no GA4 client_id stored on user. ❌       │
              └──────────────────────────────┬──────────────────────────────────┘
                                             │
                                             ▼
              ┌──── CONTENT CONSUMPTION ────────────────────────────────────────┐
              │                                                                 │
              │  ResourceProgress rows (userId + resourceId + completedAt)      │
              │  track('video_completed') / track('completed: video')           │
              │  Mux Data (viewer_user_id for authed users)                     │
              │                                                                 │
              │  CAN link: userId → content consumed ✅                          │
              │  CANNOT link: which traffic source drove this user here ❌       │
              └──────────────────────────────┬──────────────────────────────────┘
                                             │
                                             ▼
              ┌──── PURCHASE ──────────────────────────────────────────────────┐
              │                                                                │
              │  Stripe Checkout → metadata includes shortlinkRef              │
              │                                                                │
              │  IF sl_ref cookie exists at checkout:                           │
              │    → ShortlinkAttribution (type: 'purchase') ✅                │
              │    → Purchase row (userId, productId, totalAmount) ✅           │
              │  ELSE:                                                         │
              │    → Purchase row exists but NO source attribution ❌           │
              │    → Cannot answer "what brought this buyer here" ❌            │
              │                                                                │
              │  No GA4 client_id in Stripe metadata ❌                        │
              │  No UTM params in Stripe metadata ❌                           │
              │  No referrer captured at checkout ❌                            │
              └────────────────────────────────────────────────────────────────┘
```

### What CAN be correlated today

| Question | Answer | How |
|---|---|---|
| Which shortlinks drive signups? | ✅ Yes | `ShortlinkAttribution WHERE type='signup'` |
| Which shortlinks drive purchases? | ✅ Yes | `ShortlinkAttribution WHERE type='purchase'` |
| What did a specific user watch? | ✅ Yes | `ResourceProgress` + Mux Data `viewer_user_id` |
| How much revenue per product? | ✅ Yes | `Purchase` table grouped by `productId` |
| Revenue by country? | ✅ Yes | `Purchase.country` (from Vercel IP header) |

### What CANNOT be correlated today

| Question | Why Not |
|---|---|
| What % of organic traffic converts to signup? | GA4 sessions can't be joined to user records. No shared identifier. |
| Which blog post drove this purchase? | No first-touch or last-touch page captured on user/purchase. |
| Do UTM campaigns work? | UTM params are never captured or stored anywhere. They exist only in GA4 session scope. |
| What's the signup → purchase conversion rate by source? | User records have no acquisition source. Only shortlink-attributed users have source data. |
| How long from first visit to purchase? | No first-visit timestamp on user record. GA4 has it but can't join. |
| Which video drives the most purchases? | Video completion events go to GA4 (browser-side). Purchase events are server-side. No join key. |
| What's the ROI of a specific content piece? | Would need: content view → user identification → purchase. Content views for anonymous users have no user ID. |

---

## GA4 Revenue Attribution — Not Wired

GA4 has built-in multi-touch attribution models (first-click, last-click, data-driven) that automatically attribute revenue to traffic sources. **None of this works** because AI Hero never fires GA4's standard ecommerce events.

### What's missing

| GA4 Feature | Status | What it enables |
|---|---|---|
| `purchase` event (standard ecommerce) | ❌ Not fired | Revenue attribution by source/medium/campaign in all Acquisition reports |
| `sign_up` event | ❌ Not fired | Signup conversion attribution by traffic source |
| `begin_checkout` event | ❌ Not fired | Checkout funnel in GA4, abandonment tracking |
| User-ID (`user_id` on gtag config) | ❌ Not set | Cross-device session stitching, authenticated user journeys |
| Conversions marked in GA4 admin | ❓ Unknown (requires UI check) | `conversions` metric in Data API queries, attribution reports |
| GA4 Data API refresh token | ❌ Missing (`STATS_ANALYTICS_REFRESH_TOKEN` not set) | Server-side traffic queries already coded in `ga4-data.ts` |

### What firing `purchase` would unlock

Once a GA4 `purchase` event fires with `value`, `transaction_id`, `currency`, and `items`, every standard GA4 attribution report works automatically:

- **Acquisition → User acquisition**: Revenue attributed to first-touch channel (organic search, social, paid, referral, direct)
- **Acquisition → Traffic acquisition**: Revenue attributed to session-level source/medium
- **Advertising → Attribution**: Compare first-click, last-click, data-driven, linear, time-decay, position-based models
- **Explore → Funnel exploration**: Build custom funnels (page_view → sign_up → begin_checkout → purchase) with revenue at each step

### Where to fire the events

**`purchase` event**: On the `/welcome` page (authenticated post-purchase) or server-side via GA4 Measurement Protocol. The `/thanks/purchase` page is an option but it's unauthenticated (pre-login-link) so `user_id` wouldn't be set. The welcome page already has the purchase, product, and user session.

```typescript
// On /welcome page load, after purchase is confirmed
gtag('event', 'purchase', {
  transaction_id: purchase.id,
  value: Number(purchase.totalAmount),
  currency: 'USD',
  items: [{
    item_id: product.id,
    item_name: product.name,
    price: Number(purchase.totalAmount),
    quantity: 1,
  }]
})
```

**`sign_up` event**: In the auth callback when `USER_CREATED_EVENT` fires, add a client-side signal. Or fire on the `/confirm` page (post-ConvertKit subscribe redirect).

**`user_id`**: Set globally in `layout.tsx` when session exists:
```typescript
gtag('config', GA_ID, { user_id: session.user.id })
```

This is the **single highest-ROI change** in this audit. It turns GA4 from a pageview counter into a revenue attribution engine with zero additional tooling.

---

## Gaps & Recommendations

### 🔴 Critical (blocks revenue attribution)

**1. No organic/direct traffic attribution on users or purchases**

The shortlink path works beautifully. But shortlinks are only used for **intentional campaigns** — they capture maybe 10-20% of traffic. The other 80%+ (organic search, direct, social, referral) has **zero** attribution.

**Fix**: Capture first-touch attribution at signup. On the subscribe-to-list endpoint and the auth callback, read:
- `document.referrer` (pass from client)
- UTM params from URL (if present)
- `sl_ref` cookie (already done)
- GA4 `_ga` cookie (client_id for later GA4 Data API joins)

Store as a JSON blob on the User record's `fields` column (already exists, already typed as `Record<string, any>`).

**2. UTM parameters are never captured**

If someone lands on `aihero.dev?utm_source=twitter&utm_medium=social&utm_campaign=launch`, those params exist only in the GA4 session. They're never read by the app, never stored in the DB, and never forwarded to Stripe checkout metadata.

**Fix**: Add a client-side UTM capture utility that reads `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` from the URL on first page load and stores them in a cookie or sessionStorage. Forward them to:
- The subscribe-to-list endpoint
- Stripe checkout metadata (alongside `shortlinkRef`)
- The User record on signup

**3. ~~GA4 Data API is wired but non-functional~~ CORRECTED: GA4 Data API is functional**

> **Review correction**: `ga4-data.ts` was rewritten to use service-account auth (`GOOGLE_ANALYTICS_CLIENT_EMAIL` + `GOOGLE_ANALYTICS_PRIVATE_KEY`) and `routeSurface()` now has working `traffic/*` cases (lines 155-162). The GA4 Data API integration is architecturally complete.

**Remaining action**: Verify service account env vars are set in Vercel production and that the traffic surfaces return data. If they do, this gap is closed.
 — they fall through to `throw new Error('Unknown surface')`

**Fix**: 
1. Run the OAuth flow at `/api/analytics/auth` to get the refresh token
2. Add traffic cases to `routeSurface()`:
```typescript
case 'traffic':
  return getTrafficOverview(range as GA4TimeRange)
case 'traffic/daily':
  return getSessionsByDay(range as GA4TimeRange)
case 'traffic/pages':
  return getTopPages(range as GA4TimeRange, limit)
case 'traffic/sources':
  return getTrafficSources(range as GA4TimeRange, limit)
```

### 🟡 Important (improves decision quality)

**4. No first-touch page / landing page captured**

When a user signs up, we don't record what page they were on. Was it a blog post? The homepage? A workshop page? This is the simplest lever for understanding "what content converts."

**Fix**: On signup, capture `window.location.pathname` (or the referrer page) and store it on the User `fields` as `firstTouchPage`.

**5. `track()` fires to two dead endpoints**

`@skillrecordings/analytics` sends events to `window.ahoy` (not installed) and `window.fbq` (not installed). The only live destination is `gtag`. This adds ~1.2s timeout overhead per track call (the library has a 1250ms `setTimeout` fallback).

**Fix**: Either install ahoy/fbq, or replace `@skillrecordings/analytics` with a thin wrapper that just calls `gtag('event', ...)` directly. Eliminates the dead branches and the timeout.

**6. `video_series` dimension missing on most Mux views**

Only `AuthedVideoPlayer` (workshop/tutorial context) sets `videoSeries`. `PostPlayer`, `MDXVideo`, and `TrackedMuxPlayer` don't. If posts are the primary content type, most video views have no series grouping in Mux Data.

**Fix**: For posts within a list, pass the list slug as `videoSeries` in `PostPlayer`. For standalone posts, consider passing a synthetic series like `standalone-posts` or the post's primary tag.

**7. Duplicate video completion event names**

`PostPlayer` fires `video_completed`, `AuthedVideoPlayer` fires `completed: video`. Same intent, different event names, different property shapes. Makes aggregation in GA4 impossible without manual mapping.

**Fix**: Standardize on one event name (e.g., `video_completed`) with a consistent property schema: `{ video_id, video_title, resource_type, module_slug?, module_type?, binge_mode? }`.

**8. No purchase-to-content correlation**

We know WHAT a user purchased and we know what content they consumed (ResourceProgress). But there's no query or surface that joins these. "Did users who completed Lesson 3 buy more?" is answerable with the current schema — it just hasn't been built.

**Fix**: Add an analytics surface that joins `Purchase` with `ResourceProgress` by `userId` to answer: which content paths lead to purchases?

### 🟢 Nice to Have (polish)

**9. Signup/subscribe events carry no useful properties**

`track('subscribed', {})` — empty params. No form location, no page path, no referrer. Compare to `waitlist_joined` which passes `productId` and `productName`.

**Fix**: Add `{ formId, page, referrer }` to subscribe tracking calls.

**10. Admin resource creation events pollute analytics**

Eight `track()` calls in `new-resource-with-video-form.tsx` fire for admin resource creation. These are operational events, not user behavior analytics. They inflate GA4 event counts and make it harder to find real user signals.

**Fix**: Move admin operational tracking to Axiom (server-side logging) instead of GA4.

**11. Navigation click tracking is noisy**

Eight instances of `navigation_menu_item_click` in the navigation component. Every nav click fires a GA4 event. This is low-signal, high-volume data that makes GA4 event reports harder to read.

**Fix**: Consider removing or reducing to key navigation paths only.

---

## Event Taxonomy Audit (per analytics-tracking skill conventions)

The `analytics-tracking` skill prescribes **object_action** format, lowercase with underscores, no spaces or special characters. Current event names rated against that standard:

| Event Name | Conforms? | Issue |
|---|---|---|
| `video_completed` | ✅ | |
| `completed: video` | ❌ | Inverted (action: object), colon separator, space. Should be `video_completed`. |
| `Problem Prompt Copied` | ❌ | Title Case, spaces. Should be `problem_prompt_copied`. |
| `waitlist_joined` | ✅ | |
| `share_content` | ✅ | |
| `navigation_menu_item_click` | ⚠️ | Verbose but valid. Consider `nav_clicked`. |
| `nav-link-clicked` | ❌ | Hyphen instead of underscore. Should be `nav_link_clicked`. |
| `clicked_link` | ✅ | |
| `post_created` | ✅ | |
| `create_post_button_clicked` | ⚠️ | Valid but redundant with `post_created`. |
| `create_post` | ⚠️ | Admin event, not user behavior. |
| `create_top_level_resource` | ⚠️ | Admin event. |
| `resource_creation_attempt` | ⚠️ | Admin event. |
| `resource_creation_validation_error` | ⚠️ | Admin event. |
| `resource_creation_failed` | ⚠️ | Admin event. |
| `resource_creation_success` | ⚠️ | Admin event. |
| `resource_creation_error` | ⚠️ | Admin event. |
| `subscribed` | ✅ | But carries **zero properties** — useless for analysis. |

**3 events break naming convention** (`completed: video`, `Problem Prompt Copied`, `nav-link-clicked`).
**8 events are admin-only** — pollute GA4 with operational noise.
**1 duplicate concept**: `video_completed` and `completed: video` track the same thing with different names and shapes.

### Standard Properties Missing

The skill prescribes standard properties on every event: `page_title`, `page_location`, `page_referrer`. **No events currently include any of these.** The `track()` wrapper doesn't inject them either — it's a pure passthrough to `@skillrecordings/analytics`.

### GA4 Conversions

The `getTrafficSources()` GA4 Data API query requests the `conversions` metric. This only returns data if events are **marked as conversions** in GA4 Admin → Events → Mark as conversion. Unknown whether `signup_completed`, `purchase_completed`, or any other events are configured as GA4 conversions. **This needs to be checked in the GA4 admin UI** — it can't be audited from code.

### PII Audit

No PII found in any `track()` call parameters. ✅ User emails, IDs, and passwords are not passed to client-side analytics. Server-side Axiom logs include `clientIp` (via `x-forwarded-for` header) which is borderline PII under GDPR — but Axiom is server-side infrastructure, not a third-party marketing tool, so this is acceptable with a data retention policy.

---

## Aggregation Strategy

### What to pre-compute

| Metric | Source | Storage | Cadence |
|---|---|---|---|
| Daily revenue + purchase count | `Purchase` table | Rollup table or Axiom dataset | Daily cron |
| Signups per day (total + by source) | `User.createdAt` + `ShortlinkAttribution` | Rollup table | Daily cron |
| Content completion rates by resource | `ResourceProgress` | Rollup table | Daily cron |
| Shortlink → signup → purchase funnel | `ShortlinkClick` → `ShortlinkAttribution` | Computed view | On-demand (API) |
| Active users (DAU/WAU/MAU) | `ResourceProgress` distinct userId | Rollup table | Daily cron |
| Video engagement by content type | Mux Data API | Cache (Redis or DB) | Daily cron |

### Where to store

- **DB rollup tables**: Best for metrics that need to join with existing schema (revenue by product, signups by source). Add a `DailyMetrics` table with date + metric_name + dimensions + value.
- **Axiom**: Already receiving structured request logs. Good for operational metrics (API latency, error rates, traffic patterns). Already configured and flowing.
- **Redis**: Good for real-time counters if a live dashboard is built. Not currently used in ai-hero (no Redis config found in app).

### Priority order for closing the attribution gap

1. **Server-side conversion tracking** → tRPC mutations for `purchase` + `sign_up` → DB + GA4 Measurement Protocol. 100% capture, ad-blocker-proof.
2. **Set `user_id` on GA4 config** when authenticated → cross-device stitching.
3. **Mark conversions in GA4 admin** → enables attribution reports and `conversions` metric in Data API.
4. **Complete GA4 Data API OAuth flow** → get refresh token, wire traffic switch cases.
5. **Capture UTM + referrer at signup** → User `fields` column → DB-side attribution for all sources.
6. **Forward UTMs to Stripe checkout metadata** → purchase-level attribution beyond shortlinks.
7. **Add first-touch page capture** → User `fields` column → "which content converts?"
8. **Build the purchase↔content join surface** → "what did buyers consume before purchasing?"

---

## Server-Side Analytics Strategy

### The Problem

Developer audience ad-block rate is 40-60%. The `<GoogleAnalytics>` component loads gtag.js from `googletagmanager.com` — blocked by uBlock Origin, Brave, Pi-hole, and most privacy tools. When blocked, `window.gtag` is undefined and **every client-side track() call is a no-op**. GA4 sees nothing — no sessions, no pageviews, no events.

This means client-side-only analytics captures roughly half the picture. For vanity metrics (total pageviews) that's tolerable. For revenue attribution it's not.

### The Approach: Two-Tier Collection

Don't try to bypass blockers. Don't proxy gtag. Instead, split by what matters:

**Tier 1: Server-side (100% capture, cannot be blocked)**
- Critical conversion events: `sign_up`, `purchase`
- Collected via tRPC mutations or server actions
- Stored in DB (already happening for purchases)
- Also forwarded to GA4 Measurement Protocol for attribution modeling
- Axiom request logs as unblockable traffic floor (already flowing)

**Tier 2: Client-side (50-60% capture, supplementary)**
- Engagement events: video completion, nav clicks, shares
- GA4 enhanced measurement: scroll, outbound clicks
- Mux Data: video engagement metrics
- Accept the data loss — these are directional, not contractual

### Implementation: tRPC Analytics Router

Add an `analytics` tRPC router with server-side mutations:

```typescript
// src/trpc/api/routers/analytics.ts

export const analyticsRouter = createTRPCRouter({
  /**
   * Server-side purchase event.
   * Called from /welcome page after purchase confirmation.
   * Writes to GA4 Measurement Protocol — bypasses ad blockers.
   */
  trackPurchase: protectedProcedure
    .input(z.object({
      purchaseId: z.string(),
      productId: z.string(),
      productName: z.string(),
      value: z.number(),
      currency: z.string().default('USD'),
    }))
    .mutation(async ({ input, ctx }) => {
      // 1. GA4 Measurement Protocol
      await sendGA4Event({
        client_id: ctx.ga4ClientId ?? crypto.randomUUID(), // from _ga cookie
        user_id: ctx.session.user.id,
        events: [{
          name: 'purchase',
          params: {
            transaction_id: input.purchaseId,
            value: input.value,
            currency: input.currency,
            items: [{
              item_id: input.productId,
              item_name: input.productName,
              price: input.value,
              quantity: 1,
            }],
          },
        }],
      })

      // 2. Axiom (structured log, already flowing)
      await log.info('analytics.purchase', {
        userId: ctx.session.user.id,
        purchaseId: input.purchaseId,
        productId: input.productId,
        value: input.value,
      })

      return { ok: true }
    }),

  /**
   * Server-side signup event.
   * Called from auth callback or confirm page.
   */
  trackSignup: protectedProcedure
    .input(z.object({
      method: z.string().default('email'),
      referrer: z.string().optional(),
      landingPage: z.string().optional(),
      utmSource: z.string().optional(),
      utmMedium: z.string().optional(),
      utmCampaign: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // 1. GA4 Measurement Protocol
      await sendGA4Event({
        client_id: ctx.ga4ClientId ?? crypto.randomUUID(),
        user_id: ctx.session.user.id,
        events: [{
          name: 'sign_up',
          params: { method: input.method },
        }],
      })

      // 2. Store attribution on User.fields
      // (first-touch source, referrer, UTMs, landing page)

      // 3. Axiom
      await log.info('analytics.signup', {
        userId: ctx.session.user.id,
        method: input.method,
        referrer: input.referrer,
        landingPage: input.landingPage,
        utmSource: input.utmSource,
      })

      return { ok: true }
    }),
})
```

### GA4 Measurement Protocol Helper

```typescript
// src/lib/ga4-measurement.ts

const GA4_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS // G-62P9F6B30T
const GA4_API_SECRET = process.env.GA4_MEASUREMENT_API_SECRET      // create in GA4 admin

type GA4Event = {
  client_id: string
  user_id?: string
  events: Array<{
    name: string
    params: Record<string, unknown>
  }>
}

export async function sendGA4Event(payload: GA4Event): Promise<void> {
  if (!GA4_MEASUREMENT_ID || !GA4_API_SECRET) return

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${GA4_API_SECRET}`

  await fetch(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  }).catch(() => {
    // Fire and forget — don't block on analytics
  })
}
```

### Axiom as Unblockable Traffic Floor

Axiom already receives every request via the `withSkill` wrapper and `log.info('api.request.completed', ...)`. This is server-side middleware — it cannot be blocked by client-side ad blockers.

**What Axiom already captures per request:**
- `path` — the URL path
- `method` — GET/POST
- `status` — response code
- `durationMs` — response time
- `userAgent` — browser/device
- `referer` — referrer header
- `clientIp` — visitor IP
- `host`, `vercelEnv`, `vercelId` — deployment context

**What Axiom can answer today (without any changes):**
- Total pageviews/unique visitors per day (by IP or user-agent fingerprint)
- Top pages by traffic volume
- Referrer distribution (where traffic comes from)
- API error rates and latency
- Device/browser breakdown

**What Axiom CAN'T answer:**
- Session-level behavior (multiple pages in one visit)
- User identity (no userId in request logs for unauthenticated visitors)
- Revenue attribution (no purchase correlation)

**Enhancement**: For authenticated requests, inject `userId` into the Axiom log context via `createRequestContext()`. This is already partially wired — the function accepts an optional `userId` param that's currently unused by `withSkill`.

### `_ga` Cookie for Measurement Protocol Client ID

GA4 sets a `_ga` cookie (format: `GA1.1.XXXXXXXXXX.XXXXXXXXXX`). The Measurement Protocol needs a `client_id` to associate server-side events with the correct GA4 user profile.

**Read it server-side** in the tRPC context or in the checkout flow:

```typescript
const cookieStore = await cookies()
const gaCookie = cookieStore.get('_ga')?.value
// Extract client_id: "GA1.1.1234567890.1234567890" → "1234567890.1234567890"
const clientId = gaCookie?.split('.').slice(2).join('.') ?? crypto.randomUUID()
```

If the user had ad blockers and never got a `_ga` cookie, use a synthetic UUID. GA4 will create a new user profile. This is fine — the conversion event still gets recorded with `user_id`, which is the stronger join key.

### Summary: What Gets Captured Where

| Event | DB | GA4 (Measurement Protocol) | GA4 (Client gtag) | Axiom | Mux Data | Ad-block-proof? |
|---|---|---|---|---|---|---|
| Page view | ❌ | ❌ | ✅ (enhanced) | ✅ (request log) | ❌ | **Axiom only** |
| Signup | ✅ (User row) | ✅ (tRPC → MP) | ⚠️ (if gtag loaded) | ✅ (tRPC log) | ❌ | **Yes** |
| Purchase | ✅ (Purchase row) | ✅ (tRPC → MP) | ⚠️ (if gtag loaded) | ✅ (tRPC log) | ❌ | **Yes** |
| Video completed | ✅ (Progress row) | ❌ | ⚠️ (client track()) | ✅ (Mux webhook) | ✅ | **DB + Mux** |
| Shortlink click | ✅ (ShortlinkClick) | ❌ | ⚠️ (redirect) | ✅ (request log) | ❌ | **Yes** |
| Engagement (nav, share) | ❌ | ❌ | ⚠️ (client track()) | ❌ | ❌ | No |

### New Env Var Required

```
GA4_MEASUREMENT_API_SECRET=<create in GA4 Admin → Data Streams → Measurement Protocol API secrets>
```

This is a server-side secret, NOT a `NEXT_PUBLIC_` var. Never exposed to the client.

---

## Review Corrections (post-codex review, 2026-03-22)

A gpt-5.4 review of this audit against the current codebase found several corrections and additions:

### Corrections to original audit

1. **GA4 Data API traffic routes ARE implemented** — `routeSurface()` has working `traffic/*` cases at lines 155-162 of `route.ts`. The original audit read a stale version of the file.

2. **GA4 auth is service-account based, not OAuth** — `ga4-data.ts` now uses `GOOGLE_ANALYTICS_CLIENT_EMAIL` + `GOOGLE_ANALYTICS_PRIVATE_KEY`, not refresh tokens. The `/api/analytics/auth` OAuth flow may be vestigial.

3. **track() timeout is not blocking** — `@skillrecordings/analytics` calls `politelyExit()` immediately after fan-out. The 1250ms `setTimeout` is a safety net, not actual latency.

4. **Axiom is NOT a full traffic floor** — Only API routes wrapped in `withSkill` get logged. Page renders, static assets, and non-API routes are NOT logged to Axiom. Cannot be used as ground-truth pageview data without adding middleware.

### Additions from review

5. **Newsletter subscribe ≠ account signup** — The audit treated these as one event. They should be separate:
   - ConvertKit form → `generate_lead` or `subscribe` (not a user account)
   - `server/auth.ts` createUser → `sign_up` (actual account creation)
   Conflating them risks double-counting and muddy funnels.

6. **Subscription checkout flow is missing** — The audit covers one-time purchases but ignores `apps/ai-hero/src/app/(commerce)/thanks/subscription/page.tsx` and the `/welcome?subscriptionId=...` path. Must instrument both.

7. **Store attribution on `Purchase.fields` too, not just `User.fields`** — `Purchase.fields` (JSON column, already exists) should snapshot conversion-time attribution: source/medium/campaign, shortlinkRef, gaClientId, landing path. Immutable per-purchase, not overwritten on repeat purchases.

8. **Fire-and-forget attribution writes can drop data** — Both `recordClick().catch()` in `s/[slug]/route.ts` and `createShortlinkAttribution().catch()` in the subscribe route are not awaited. On serverless/edge, the runtime can exit before the write completes. Consider making these durable (Inngest event or awaited write).

9. **`sl_ref` cookie is `httpOnly: false` for no reason** — Set in `s/[slug]/route.ts:57`. Both consumers (checkout and subscribe) read it server-side. Making it `httpOnly: true` prevents client-side tampering with no functionality loss.

10. **Use existing durable server paths for conversion events** — Rather than making tRPC the primary conversion emitter, the review recommends:
    - Purchase conversion → emit from the existing `NEW_PURCHASE_CREATED_EVENT` Inngest flow (already durable, already has purchase context)
    - Signup conversion → emit from `server/auth.ts` createUser callback (already fires `USER_CREATED_EVENT`)
    - Use tRPC only for browser-only context (UTMs, referrer, landing page, GA cookies) that can't be captured server-side

11. **Capture first-touch data at landing, not at signup** — By signup time, `document.referrer` and URL params are often wrong (internal referrers, Stripe return flows). Snapshot UTMs + referrer + landing path into a first-party cookie on first page load, then read it later at conversion time.

12. **Admin dashboard doesn't use `/api/analytics`** — `apps/ai-hero/src/app/admin/analytics/page.tsx` imports query functions directly from `analytics-queries.ts`. Fixing the API route is not a dashboard win unless the dashboard is refactored to consume it.

13. **Double-counting risk** — If conversions fire from both client gtag on `/welcome` AND server-side Measurement Protocol AND Inngest, they'll be counted multiple times. Need one canonical emitter per event type, with idempotency markers (e.g., `Purchase.fields.ga4_sent = true`).

14. **`getTrafficSources()` does NOT request `conversions` metric** — It only requests `sessions` + `totalUsers`. The audit's claim about needing GA4 admin conversion settings for this query was wrong (though the general point about marking conversions is valid).

### Revised priority order

1. **Capture first-touch data on landing** — UTMs, referrer, landing path, GA client ID → first-party cookie
2. **Snapshot attribution onto both `User.fields` and `Purchase.fields`** — extend existing checkout metadata path
3. **Emit durable purchase conversion** from Inngest `NEW_PURCHASE_CREATED_EVENT` → GA4 Measurement Protocol (idempotent, not from fragile client page)
4. **Emit durable signup conversion** from `server/auth.ts` createUser → GA4 MP (separate from newsletter subscribe)
5. **Handle subscription conversions** explicitly alongside one-time purchases
6. **Surface GA4 traffic data in admin dashboard** — `ga4-data.ts` is ready, wire it into the existing server-rendered page
7. **Clean up event taxonomy** — standardize names, separate admin events, fix duplicate video completion events
8. **Make attribution writes durable** — await or Inngest-ify the fire-and-forget shortlink click/signup writes
9. **Set `sl_ref` to `httpOnly: true`**
10. **Optional tRPC mutation** for flushing client-only context (UTMs, GA cookies) that can't be captured server-side

---

## Tracking Plan (per analytics-tracking skill format)

### Conversion Events (server-side, durable)

| Event Name | Description | Properties | Trigger | Emitter |
|---|---|---|---|---|
| `sign_up` | User account created | `method`, `first_touch_source`, `first_touch_page`, `utm_source`, `utm_medium`, `utm_campaign` | `server/auth.ts` createUser | Inngest `USER_CREATED_EVENT` → GA4 MP |
| `generate_lead` | Newsletter subscribe | `form_id`, `page`, `shortlink_ref` | ConvertKit subscribe endpoint | Server action in subscribe route |
| `purchase` | One-time product purchase | `transaction_id`, `value`, `currency`, `product_id`, `product_name`, `shortlink_ref`, `utm_source`, `utm_medium`, `utm_campaign` | Inngest `NEW_PURCHASE_CREATED_EVENT` | Inngest function → GA4 MP |
| `subscribe` | Subscription checkout | `transaction_id`, `value`, `currency`, `product_id`, `interval` | Inngest subscription event | Inngest function → GA4 MP |
| `begin_checkout` | Checkout session created | `value`, `currency`, `product_id` | Stripe checkout creation | Server-side in checkout flow |

### Engagement Events (client-side, accept data loss from ad blockers)

| Event Name | Description | Properties | Trigger | Emitter |
|---|---|---|---|---|
| `video_completed` | User finishes a video | `video_id`, `video_title`, `resource_type`, `module_slug`, `module_type`, `binge_mode` | MuxPlayer `onEnded` | Client `track()` → gtag |
| `waitlist_joined` | User joins product waitlist | `product_id`, `product_name` | Waitlist form submit | Client `track()` → gtag |
| `content_shared` | User shares content | `url`, `method` | Share button click | Client `track()` → gtag |
| `problem_prompt_copied` | User copies problem prompt | `lesson_id` | Copy button click | Client `track()` → gtag |

### GA4 Custom Dimensions

| Name | Scope | Parameter | Source |
|---|---|---|---|
| `user_type` | User | `user_type` | `session.user.role` (user, admin, etc.) |
| `content_type` | Event | `content_type` | Resource type (post, lesson, workshop, tutorial) |
| `acquisition_source` | User | `acquisition_source` | First-touch UTM source from cookie |
| `product_name` | Event | `product_name` | Product being purchased/viewed |

### GA4 Conversions to Mark in Admin

| Conversion | Event | Counting Method |
|---|---|---|
| Account Created | `sign_up` | Once per user |
| Lead Generated | `generate_lead` | Once per session |
| Purchase | `purchase` | Every event (each is a unique transaction) |
| Subscription | `subscribe` | Every event |

## Validation Plan

### Pre-deployment checks

- [ ] GA4 Measurement Protocol API secret set in Vercel (`GA4_MEASUREMENT_API_SECRET`)
- [ ] Service account credentials set (`GOOGLE_ANALYTICS_CLIENT_EMAIL`, `GOOGLE_ANALYTICS_PRIVATE_KEY`)
- [ ] `env.mjs` updated with `GA4_MEASUREMENT_API_SECRET` validation

### Post-deployment verification

- [ ] **GA4 DebugView**: Fire a test purchase through staging/preview → verify `purchase` event appears with correct `transaction_id`, `value`, `items`
- [ ] **GA4 DebugView**: Create a test account → verify `sign_up` event appears with `method` property
- [ ] **GA4 Realtime**: Verify `user_id` appears in User Explorer for authenticated sessions
- [ ] **Sandbox purchase**: Complete a real $0 coupon purchase → verify:
  - `Purchase.fields` has attribution snapshot (UTMs, shortlinkRef, gaClientId, landing page)
  - `User.fields` has first-touch acquisition data
  - `ShortlinkAttribution` row created (if via shortlink)
  - GA4 shows the purchase event with revenue = $0
- [ ] **Shortlink chain**: Click shortlink → subscribe → purchase → verify full attribution chain in DB
- [ ] **No duplicate events**: Refresh `/welcome` page → verify purchase event does NOT fire again (idempotency check via `Purchase.fields.ga4_sent`)
- [ ] **Ad-blocked scenario**: Test with uBlock Origin enabled → verify server-side events still fire and appear in GA4
- [ ] **Mux dimensions**: Play a post video → check Mux Data dashboard for `video_series`, `sub_property_id`, `viewer_plan` population
- [ ] **Event taxonomy**: Run `grep -rn "track(" apps/ai-hero/src/ | grep -v node_modules` → verify no old-format events remain

---

## Integration with Existing Analytics Surfaces

### Current surfaces

**Admin dashboard** (`/admin/analytics`): Server-rendered, imports directly from `analytics-queries.ts`. Shows revenue summary, daily chart, by-product, by-country, shortlink performance, attribution counts, recent purchases.

**API route** (`/api/analytics`): HATEOAS JSON endpoint with `?surface=...&range=...`. Same DB queries as dashboard plus GA4 traffic surfaces (`traffic`, `traffic/daily`, `traffic/pages`, `traffic/sources`). Auth: admin device token.

### What needs to change

#### 1. New query functions in `analytics-queries.ts`

```typescript
// Revenue by acquisition source (first-touch attribution from User.fields)
export async function getRevenueBySource(range: AnalyticsTimeRange)
// → joins Purchase + User, groups by User.fields.acquisitionSource
// → returns: { source, medium, campaign, revenue, purchaseCount }[]

// Signup-to-purchase conversion funnel
export async function getConversionFunnel(range: AnalyticsTimeRange)
// → counts: total signups, signups with attribution, purchases, purchases with attribution
// → returns: { totalSignups, attributedSignups, totalPurchases, attributedPurchases, conversionRate }

// Content-to-purchase correlation
export async function getContentPurchaseCorrelation(range: AnalyticsTimeRange, limit?: number)
// → joins Purchase + ResourceProgress by userId, groups by resourceId
// → returns: { resourceId, resourceTitle, resourceType, purchaserCount, completionRate }[]

// Full attribution chain for a purchase
export async function getPurchaseAttribution(purchaseId: string)
// → reads Purchase.fields for conversion-time snapshot
// → reads User.fields for first-touch acquisition
// → reads ShortlinkAttribution for shortlink path
// → returns: { firstTouch: {...}, conversionTime: {...}, shortlink?: {...} }

// Attributed revenue summary (how much revenue can we trace to a source)
export async function getAttributedRevenueSummary(range: AnalyticsTimeRange)
// → Purchase WHERE fields->>'acquisitionSource' IS NOT NULL, grouped
// → returns: { attributedRevenue, unattributedRevenue, attributionRate, bySource: [...] }
```

#### 2. New API route surfaces

Add to `VALID_SURFACES` and `routeSurface()` in `/api/analytics/route.ts`:

| Surface | Query Function | What it answers |
|---|---|---|
| `attribution/sources` | `getRevenueBySource` | Revenue by first-touch source/medium/campaign |
| `attribution/funnel` | `getConversionFunnel` | Signup → purchase conversion rates |
| `attribution/content` | `getContentPurchaseCorrelation` | Which content paths lead to purchases |
| `attribution/purchase/:id` | `getPurchaseAttribution` | Full attribution chain for one purchase |
| `attribution/coverage` | `getAttributedRevenueSummary` | What % of revenue is attributed vs dark |

#### 3. Admin dashboard additions

The existing dashboard gets three new cards/sections:

**Attribution coverage card** (top stats row):
- "Attributed Revenue: $X (Y%)" — how much revenue has a known source
- "Dark Revenue: $X (Z%)" — revenue with no attribution data
- This is the key metric that tells you whether the attribution work is paying off

**Revenue by source table** (new section):
- Source | Medium | Campaign | Revenue | Purchases | Avg Order
- Replaces the current "Attributed Signups" stat card with richer data
- Shows shortlink, organic, direct, social, email — whatever first-touch captured

**Content → Purchase panel** (new section):
- Top resources consumed by purchasers before buying
- Completion rate among purchasers vs non-purchasers
- "Users who watched X were Y% more likely to purchase"

#### 4. GA4 traffic ↔ DB revenue correlation

The `/api/analytics` route already has both GA4 traffic data and DB revenue data. A new composite surface can join them:

```typescript
// New surface: traffic-to-revenue correlation
case 'correlation/traffic-revenue':
  const [traffic, revenue] = await Promise.all([
    getSessionsByDay(toGA4Range(range)),   // GA4: sessions per day
    getRevenueByDay(range),                // DB: revenue per day
  ])
  // Merge on date, compute revenue-per-session
  return mergeTrafficRevenue(traffic, revenue)
```

This gives you "revenue per session per day" — a simple but powerful metric that shows whether traffic quality is improving.

#### 5. Dashboard client changes

`AnalyticsDashboardClient` needs updated types and new sections. The `AnalyticsDashboardData` interface adds:

```typescript
interface AnalyticsDashboardData {
  // ... existing fields ...
  revenueBySource: { source: string; medium: string; campaign: string; revenue: number; count: number }[]
  conversionFunnel: { totalSignups: number; attributedSignups: number; totalPurchases: number; attributedPurchases: number; conversionRate: number }
  attributionCoverage: { attributedRevenue: number; unattributedRevenue: number; attributionRate: number }
  contentCorrelation: { resourceId: string; resourceTitle: string; resourceType: string; purchaserCount: number }[]
}
```

The server page adds those queries to the `Promise.all` in `DashboardContent`.

---

## Agent-First Analytics API Design (per cli-design skill)

The existing `/api/analytics` route returns `next_actions` as flat URL strings. That's not agent-consumable — an agent can't discover parameters, valid values, or what each surface answers without reading source code. Per the `cli-design` skill, every response should be a self-documenting HATEOAS envelope with templated actions.

### Current (weak)

```json
{
  "surface": "summary",
  "range": "30d",
  "data": { "totalRevenue": 12500, "purchaseCount": 45, "avgOrderValue": 277 },
  "next_actions": {
    "revenue_daily": "/api/analytics?surface=revenue/daily&range=30d",
    "attribution": "/api/analytics?surface=attribution&range=30d"
  }
}
```

Problems:
- No descriptions — agent doesn't know what `revenue_daily` shows
- No parameter discovery — agent doesn't know valid ranges or surfaces
- No error envelope — errors return plain `{ error: "..." }`
- `next_actions` is an object of URLs, not an array of action templates
- No root self-documentation — agent must know the API shape in advance

### Proposed (agent-first)

#### Root discovery: `GET /api/analytics`

No `surface` param → returns the full surface catalog:

```json
{
  "ok": true,
  "endpoint": "/api/analytics",
  "description": "AI Hero analytics — revenue, attribution, traffic, and content correlation",
  "surfaces": [
    {
      "name": "summary",
      "description": "Revenue overview: total, purchase count, AOV",
      "category": "revenue"
    },
    {
      "name": "revenue/daily",
      "description": "Revenue and purchase count per day",
      "category": "revenue"
    },
    {
      "name": "attribution/sources",
      "description": "Revenue attributed to first-touch acquisition source/medium/campaign",
      "category": "attribution"
    },
    {
      "name": "attribution/funnel",
      "description": "Signup → purchase conversion rates with attribution coverage",
      "category": "attribution"
    },
    {
      "name": "attribution/content",
      "description": "Content resources most consumed by purchasers before buying",
      "category": "attribution"
    },
    {
      "name": "correlation/traffic-revenue",
      "description": "GA4 sessions merged with DB revenue by day — revenue per session",
      "category": "correlation"
    },
    {
      "name": "traffic",
      "description": "GA4 traffic overview: sessions, users, pageviews, bounce rate",
      "category": "traffic"
    }
  ],
  "next_actions": [
    {
      "command": "GET /api/analytics?surface=<surface>&range=<range>",
      "description": "Query a specific analytics surface",
      "params": {
        "surface": {
          "required": true,
          "enum": ["summary", "revenue/daily", "revenue/products", "revenue/countries",
                   "purchases/recent", "attribution", "attribution/shortlinks",
                   "attribution/sources", "attribution/funnel", "attribution/content",
                   "attribution/coverage", "correlation/traffic-revenue",
                   "traffic", "traffic/daily", "traffic/pages", "traffic/sources"],
          "description": "Analytics surface to query"
        },
        "range": {
          "default": "30d",
          "enum": ["24h", "7d", "30d", "90d", "all"],
          "description": "Time range"
        }
      }
    }
  ]
}
```

#### Surface response envelope

```json
{
  "ok": true,
  "endpoint": "/api/analytics",
  "surface": "attribution/sources",
  "range": "30d",
  "description": "Revenue attributed to first-touch acquisition source/medium/campaign",
  "data": [
    { "source": "google", "medium": "organic", "campaign": null, "revenue": 4200, "count": 12 },
    { "source": "twitter", "medium": "social", "campaign": "launch_march", "revenue": 1800, "count": 6 },
    { "source": "(direct)", "medium": "(none)", "campaign": null, "revenue": 3100, "count": 15 },
    { "source": "shortlink", "medium": "shortlink", "campaign": null, "revenue": 2400, "count": 8 }
  ],
  "meta": {
    "totalRows": 4,
    "truncated": false,
    "queryTimeMs": 42
  },
  "next_actions": [
    {
      "command": "GET /api/analytics?surface=attribution/funnel&range=<range>",
      "description": "See signup → purchase conversion rates",
      "params": {
        "range": { "value": "30d", "enum": ["24h", "7d", "30d", "90d", "all"] }
      }
    },
    {
      "command": "GET /api/analytics?surface=attribution/content&range=<range>",
      "description": "Which content paths lead to purchases",
      "params": {
        "range": { "value": "30d", "enum": ["24h", "7d", "30d", "90d", "all"] }
      }
    },
    {
      "command": "GET /api/analytics?surface=attribution/coverage&range=<range>",
      "description": "What % of revenue is attributed vs dark",
      "params": {
        "range": { "value": "30d", "enum": ["24h", "7d", "30d", "90d", "all"] }
      }
    },
    {
      "command": "GET /api/analytics?surface=correlation/traffic-revenue&range=<range>",
      "description": "Merge GA4 sessions with DB revenue — revenue per session trend",
      "params": {
        "range": { "value": "30d", "enum": ["24h", "7d", "30d", "90d", "all"] }
      }
    }
  ]
}
```

#### Error envelope

```json
{
  "ok": false,
  "endpoint": "/api/analytics",
  "error": {
    "message": "GA4 service account credentials not configured",
    "code": "GA4_AUTH_MISSING"
  },
  "fix": "Set GOOGLE_ANALYTICS_CLIENT_EMAIL and GOOGLE_ANALYTICS_PRIVATE_KEY in Vercel env",
  "next_actions": [
    {
      "command": "GET /api/analytics?surface=summary&range=<range>",
      "description": "Query DB-only surfaces (revenue, attribution) which don't need GA4",
      "params": {
        "range": { "default": "30d", "enum": ["24h", "7d", "30d", "90d", "all"] }
      }
    }
  ]
}
```

### Key design decisions

1. **Root returns surface catalog** — Agent hits `/api/analytics` with no params, gets back every available surface with descriptions. No docs needed. Self-documenting.

2. **`next_actions` are contextual** — After querying `attribution/sources`, the suggested next actions are attribution-adjacent surfaces (funnel, content, coverage), not unrelated ones. The agent is guided through a coherent analytical flow.

3. **`next_actions` use template syntax** — `<surface>` and `<range>` are parameterised with `enum` values. Agent knows valid choices without guessing. `value` pre-fills from current query context.

4. **`meta` block** — `totalRows`, `truncated`, `queryTimeMs` protect agent context. If result is truncated, agent knows. If query was slow, agent can adjust.

5. **Error envelope matches cli-design skill** — `ok: false`, machine-readable `code`, plain-language `fix`, and `next_actions` that suggest fallback surfaces (e.g., "GA4 is down but DB surfaces still work").

6. **Categories on surfaces** — `revenue`, `attribution`, `traffic`, `correlation`. Agents can group and prioritise surfaces by category.

### Implementation notes

Replace the current `buildNextActions()` function with a new `buildAgentResponse()` that:
- Returns the full envelope (not just data + next_actions)
- Generates contextual next_actions based on the current surface's category
- Includes `meta` with timing and truncation info
- Uses the error envelope for all error paths
- Returns the surface catalog when no `surface` param is provided

The existing `routeSurface()` switch stays — just wrap its output in the new envelope.

### Agent consumption pattern

```
Agent: GET /api/analytics
       → reads surface catalog, picks "attribution/sources"

Agent: GET /api/analytics?surface=attribution/sources&range=30d
       → reads data, sees next_action for "attribution/coverage"
       → "42% of revenue is unattributed — need more first-touch capture"

Agent: GET /api/analytics?surface=correlation/traffic-revenue&range=30d
       → sees revenue-per-session trending up this week
       → correlates with a specific content push

Agent: summarizes findings, recommends action
```

No docs. No schema lookup. No trial-and-error. The API teaches the agent how to use it.

---

## YouTube Analytics Integration

YouTube is the #1 traffic source (~20K sessions/week from youtube.com referrals per GA4). Currently we can see that traffic comes from YouTube but not WHICH videos drive it or how it correlates with revenue.

### What exists

- **OAuth auth endpoint**: `src/app/api/analytics/youtube-auth/route.ts` — one-time consent flow for Matt. Stores a refresh token for analytics plus YouTube channel management. Admin verification is available at `/api/analytics/youtube-auth?verify=1`.
- **OAuth credentials**: `YOUTUBE_OAUTH_CLIENT_ID` and `YOUTUBE_OAUTH_CLIENT_SECRET` in env. Project: `ai-hero-calendar-484512`.
- **APIs enabled**: YouTube Data API v3 + YouTube Analytics API. Live broadcast management rides on the Data API.
- **googleapis**: Already in `package.json` (v148).
- **env.mjs validation**: `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`, `YOUTUBE_ANALYTICS_REFRESH_TOKEN` all defined as optional.
- **Blocked on**: Matt completing the OAuth consent flow. `YOUTUBE_ANALYTICS_REFRESH_TOKEN` doesn't exist yet.

### Data layer: `src/lib/youtube-data.ts`

Auth pattern (OAuth2, not service account — YouTube Analytics API doesn't support SA):

```typescript
import { google } from 'googleapis'

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_OAUTH_CLIENT_ID,
  process.env.YOUTUBE_OAUTH_CLIENT_SECRET,
)
oauth2Client.setCredentials({
  refresh_token: process.env.YOUTUBE_ANALYTICS_REFRESH_TOKEN,
})

const youtube = google.youtube({ version: 'v3', auth: oauth2Client })
const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client })
```

Functions:

| Function | API | Returns | Cache |
|---|---|---|---|
| `getChannelOverview()` | Data API v3 `channels.list({ mine: true })` | subscriberCount, viewCount, videoCount | 15min |
| `getVideoPerformance(range)` | Analytics API `reports.query` per-video | videoId, title, views, estimatedMinutesWatched, avgViewDuration, subscribersGained, likes, comments | 15min |
| `getChannelTimeseries(range)` | Analytics API `reports.query` daily | date, views, estimatedMinutesWatched | 15min |
| `getTrafficSources(range)` | Analytics API `reports.query` by insightTrafficSourceType | source (search, suggested, external, etc.), views, estimatedMinutesWatched | 15min |

**Gotchas**:
- YouTube Analytics API has a **2-day data delay** — surface this in UI
- Channel ID fetched dynamically via `youtube.channels.list({ mine: true })`, not hardcoded
- 10,000 quota units/day — cache aggressively with `next: { revalidate: 900 }` (15min, same as Mux pattern in `mux-data.ts`)
- Graceful fallback everywhere when `YOUTUBE_ANALYTICS_REFRESH_TOKEN` is missing

### API surfaces

Add to `VALID_SURFACES` and `routeSurface()`:

| Surface | Function | Description | Category |
|---|---|---|---|
| `youtube` | `getChannelOverview()` | Subscriber count, total views, video count | youtube |
| `youtube/videos` | `getVideoPerformance(range)` | Per-video views, watch time, subs gained | youtube |
| `youtube/daily` | `getChannelTimeseries(range)` | Daily channel views + watch minutes | youtube |
| `youtube/sources` | `getTrafficSources(range)` | Where YouTube views come from (search, suggested, external) | youtube |

When `YOUTUBE_ANALYTICS_REFRESH_TOKEN` is missing, all youtube/* surfaces return:

```json
{
  "ok": false,
  "error": {
    "message": "YouTube not connected",
    "code": "YOUTUBE_AUTH_MISSING"
  },
  "fix": "Have the channel owner complete the OAuth flow at /api/analytics/youtube-auth",
  "next_actions": [
    {
      "command": "GET /api/analytics/youtube-auth",
      "description": "Start YouTube OAuth consent flow (requires channel owner)"
    }
  ]
}
```

### Agent-first surface catalog entry

When root `/api/analytics` returns the surface catalog, YouTube surfaces are included:

```json
{
  "name": "youtube/videos",
  "description": "Per-video performance: views, watch time, subscribers gained. 2-day data delay.",
  "category": "youtube",
  "available": false,
  "unavailable_reason": "YOUTUBE_AUTH_MISSING"
}
```

The `available` flag lets agents skip surfaces they know will fail.

### Dashboard additions

**YouTube stat cards** (top row, alongside revenue):
- Subscribers (total)
- Channel views (period)
- Watch hours (period)

**Per-video performance table** (new section):
- Title | Views | Watch Hours | Avg Duration | Subs Gained | Likes
- Sortable by views or watch time
- Same table pattern as Mux video dashboard at `src/app/admin/video-dashboard/_components/top-videos-table.tsx`

**Channel timeseries chart** (new section):
- Daily views + watch minutes, same Recharts pattern as `revenue-chart.tsx`
- Theme-aware colors from `use-chart-colors.ts`

### The correlation chart (the killer feature)

Overlay three timeseries on one chart:

1. **YouTube daily views** — from `youtube/daily`
2. **GA4 daily sessions from youtube.com** — filter `getSessionsByDay` or add a new `getSessionsBySource('youtube.com', range)` function
3. **Daily revenue** — from `revenue/daily`

This answers: "When I publish a video, does it show up as views → traffic → purchases?"

Implementation: a new composite surface `correlation/youtube-revenue` that merges all three by date:

```typescript
case 'correlation/youtube-revenue':
  const [ytDaily, ga4Daily, revDaily] = await Promise.all([
    getChannelTimeseries(toYTRange(range)),
    getSessionsBySourceDay('youtube.com', toGA4Range(range)),  // new function
    getRevenueByDay(range),
  ])
  return mergeByDate(ytDaily, ga4Daily, revDaily)
```

Returns:

```json
[
  {
    "date": "2026-03-20",
    "youtubeViews": 4200,
    "youtubeWatchMinutes": 12400,
    "ga4SessionsFromYoutube": 850,
    "revenue": 2400,
    "purchases": 8
  }
]
```

### New GA4 helper needed

`getSessionsBySourceDay(source, range)` — filters GA4 `sessionSource` dimension by a specific value and returns daily sessions. This doesn't exist yet but is a straightforward extension of `getSessionsByDay()` with an added dimension filter.

### Priority within the broader analytics roadmap

YouTube integration slots in after the core attribution plumbing (steps 1-5 of the revised priority list) because:
- It depends on `YOUTUBE_ANALYTICS_REFRESH_TOKEN` which doesn't exist yet
- The correlation chart needs the `revenue/daily` and GA4 traffic surfaces to already be reliable
- But the data layer can be built now and will just return graceful errors until Matt authorizes

Recommended sequencing:
1. Build `youtube-data.ts` + wire API surfaces (can ship immediately, fails gracefully)
2. Matt completes OAuth flow → token stored → surfaces go live
3. Build correlation chart once both YouTube + GA4 daily data is flowing
4. Add to admin dashboard

---

## Omnibus Analytics Dashboard Architecture

### Concept

One dashboard that surfaces ALL analytics data with three interaction modes:

1. **Visual overview** — cards, charts, tables drawing from all 21 API surfaces
2. **Attribution trail** — trace any purchase or signup back through the full chain (YouTube → GA4 → shortlink → signup → content consumption → purchase)
3. **Chat with metrics** — AI agent with the analytics API as a tool, answers natural language questions about the business

### Page structure: `/admin/analytics` (replace current)

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Hero Analytics                                    [7d ▾]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ Revenue  │ │ Purchases│ │ YT Subs  │ │ Sessions │          │
│  │ $12,500  │ │    45    │ │  166K    │ │  28,400  │          │
│  │ +12% ▲   │ │ +8% ▲   │ │ +2,373   │ │ from YT  │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
│  ┌─ Promoted Metrics (Matt configurable) ──────────────────┐   │
│  │  [drag to reorder, pin/unpin, expand/collapse]          │   │
│  │  • YouTube-Revenue Correlation chart (pinned)           │   │
│  │  • Attribution Coverage: 42% attributed, 58% dark       │   │
│  │  • Top 5 videos by views this period                    │   │
│  │  • Revenue by source (organic, shortlink, direct, yt)   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ Attribution Trail ─────────────────────────────────────┐   │
│  │  [Search by email, purchase ID, or shortlink]           │   │
│  │  joel@egghead.io:                                       │   │
│  │  YT video EJyuu6zlQCg → /s/yt-typescript → signup      │   │
│  │  → watched 12 lessons → purchased Pro ($249)            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ Chat ──────────────────────────────────────────────────┐   │
│  │  💬 "What was our best performing YouTube video          │   │
│  │      this month in terms of driving purchases?"          │   │
│  │                                                          │   │
│  │  📊 Based on the correlation data, EJyuu6zlQCg had      │   │
│  │  121K views and the revenue spike on Mar 16-18          │   │
│  │  ($4,200 in 3 days) aligns with its publish date...     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ All Surfaces ──────────────────────────────────────────┐   │
│  │  [Collapsed sections for each category]                  │   │
│  │  ▸ Revenue (5 surfaces)                                  │   │
│  │  ▸ Attribution (5 surfaces)                              │   │
│  │  ▸ Traffic (4 surfaces)                                  │   │
│  │  ▸ YouTube (4 surfaces)                                  │   │
│  │  ▸ Correlation (2 surfaces)                              │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Promoted Metrics (Matt's tuning surface)

Store Matt's dashboard preferences in user prefs (AI_UserPrefs table, already exists):

```typescript
// UserPrefs key: 'analytics_dashboard'
// Value: JSON
{
  pinnedSurfaces: ['correlation/youtube-revenue', 'attribution/coverage'],
  surfaceOrder: ['youtube/videos', 'attribution/sources', 'revenue/daily'],
  expandedCategories: ['youtube', 'attribution'],
  defaultRange: '30d',
}
```

The dashboard reads these prefs server-side. Matt drags cards to reorder, pins/unpins, and the UI writes back via tRPC mutation. No config file — it's per-user in the DB.

### Chat with Metrics — AI SDK `streamText` + tools

Route: `POST /api/admin/analytics-chat`

The AI agent gets the analytics API as a tool. It can call any surface, cross-reference results, and reason about the business.

```typescript
// apps/ai-hero/src/app/api/admin/analytics-chat/route.ts

import { openai } from '@ai-sdk/openai'
import { streamText, tool } from 'ai'
import { z } from 'zod'
import { routeSurface, SURFACE_CATALOG } from '../analytics/route'

export const POST = withSkill(async (req: Request) => {
  // Auth check (same as analytics route)...

  const { messages } = await req.json()

  const result = streamText({
    model: openai('gpt-4o'),
    system: `You are an analytics assistant for AI Hero, a developer education platform.
You have access to 21 analytics surfaces covering revenue, attribution, traffic, YouTube, and content correlation.
When asked a question, query the relevant surfaces, cross-reference data, and provide specific numbers with context.
Always cite which surface(s) you queried.
The YouTube Analytics API has a 2-day data delay — note this when discussing recent YouTube data.`,
    messages,
    tools: {
      queryAnalytics: tool({
        description: `Query an AI Hero analytics surface. Available surfaces: ${SURFACE_CATALOG.map(s => `${s.name} (${s.description})`).join('; ')}`,
        parameters: z.object({
          surface: z.enum(SURFACE_CATALOG.map(s => s.name) as [string, ...string[]]),
          range: z.enum(['24h', '7d', '30d', '90d', 'all']).default('30d'),
          limit: z.number().optional(),
        }),
        execute: async ({ surface, range, limit }) => {
          return routeSurface(surface, range as any, limit ?? 20)
        },
      }),
    },
    maxSteps: 5, // Allow multi-step reasoning (query → analyze → query more)
  })

  return result.toDataStreamResponse()
})
```

Client side uses `useChat` from `@ai-sdk/react`:

```typescript
// apps/ai-hero/src/app/admin/analytics/_components/analytics-chat.tsx
'use client'

import { useChat } from '@ai-sdk/react'

export function AnalyticsChat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/admin/analytics-chat',
  })

  return (
    <div className="...">
      {messages.map(m => (
        <div key={m.id}>
          {m.role === 'user' ? '💬' : '📊'} {m.content}
          {m.toolInvocations?.map(t => (
            <details key={t.toolCallId}>
              <summary>Queried: {t.args.surface} ({t.args.range})</summary>
              <pre>{JSON.stringify(t.result, null, 2)}</pre>
            </details>
          ))}
        </div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} placeholder="Ask about your metrics..." />
      </form>
    </div>
  )
}
```

### Key design decisions

1. **`routeSurface` is the shared query engine** — both the REST API and the chat agent use the same function. No duplicate query paths. The agent doesn't call the HTTP API — it calls the function directly, avoiding auth overhead and network latency.

2. **`maxSteps: 5`** — the agent can make multiple tool calls per turn. "Compare YouTube performance to revenue this month" requires querying `youtube/videos`, `revenue/daily`, and `correlation/youtube-revenue` — three calls in one conversation turn.

3. **Tool results are visible in the UI** — `toolInvocations` are rendered as expandable details. Matt can see exactly which surfaces the agent queried and what data it saw. Transparency, not magic.

4. **Promoted metrics are user preferences, not code changes** — Matt reorders the dashboard by dragging. No deploy needed. Stored in UserPrefs table which already exists.

5. **Attribution trail is a purpose-built lookup** — not a generic surface query. It needs a new server action that takes an email or purchase ID and walks the chain: User → Purchase → ShortlinkAttribution → ShortlinkClick → ResourceProgress. Returns a timeline of touchpoints.

### What the chat agent can answer

With 21 surfaces as tools, the agent can answer questions like:

- "What's our conversion rate from YouTube to purchase?"
- "Which video drove the most revenue this month?"
- "How does our attribution coverage compare to last month?"
- "What content do purchasers watch before buying?"
- "Is traffic from YouTube search growing or declining?"
- "What percentage of revenue comes from shortlinks vs organic?"
- "Show me the full attribution trail for joel@egghead.io"

### Implementation order

1. **Analytics chat route** — `POST /api/admin/analytics-chat` with `routeSurface` as a tool
2. **Chat UI component** — `useChat` with tool invocation rendering
3. **Attribution trail server action** — lookup by email/purchaseId/shortlink
4. **Dashboard layout** — promoted metrics, collapsible categories, stat cards
5. **User prefs for dashboard config** — pin/unpin, reorder, default range

Steps 1-2 are the quick win — the chat agent works as soon as the route exists. Steps 3-5 are the visual polish.

---

## Analytics Chat Agent — Implementation Plan

### Skills Required

Load these before implementation:

| Skill | Why |
|---|---|
| `ai-sdk-tools` | Tool calling pattern — define analytics surfaces as AI SDK tools with Zod schemas |
| `ai-sdk-core` | `streamText` with tools, `maxSteps` for multi-step reasoning, provider config |
| `ai-sdk-react` | `useChat` hook for the client-side chat interface |
| `ai-elements` | Pre-built chat UI components: Conversation, Message, Tool, PromptInput |
| `recharts` | Chart rendering inside chat responses (tool results with visual output) |
| `analytics-tracking` | Event naming conventions, tracking plan structure, GA4 implementation |
| `next-best-practices` | RSC boundaries, route handlers, async APIs |
| `next-cache-components` | Cache the dashboard shell, dynamic slots for chat + live data |
| `nextjs-rendering` | Server/Client component split — dashboard is server-rendered, chat is client |
| `vercel-composition-patterns` | Compound component patterns for the dashboard card system |
| `frontend-design` | Production-grade UI that doesn't look like default shadcn |

### Architecture

```
┌─ /admin/analytics (Server Component) ──────────────────────────┐
│                                                                  │
│  ┌─ DashboardShell (cached, static) ─────────────────────────┐  │
│  │  Header, nav, range selector, category tabs               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ MetricsGrid (server, dynamic) ───────────────────────────┐  │
│  │  StatCards from summary + youtube + traffic surfaces       │  │
│  │  Promoted metrics from UserPrefs                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ AnalyticsChat (client component) ────────────────────────┐  │
│  │  useChat → POST /api/admin/analytics-chat                 │  │
│  │  ai-elements: Conversation, Message, Tool, PromptInput    │  │
│  │  Tool results render inline with charts (Recharts)        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ SurfaceExplorer (client, collapsible) ───────────────────┐  │
│  │  All 21 surfaces grouped by category                      │  │
│  │  Click to expand → inline data table/chart                │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Chat Route: `POST /api/admin/analytics-chat`

Dual auth (same pattern as `/api/analytics`):
- Session cookie (admin logged into /admin)
- Device token (Bearer header for API consumers)

```typescript
// apps/ai-hero/src/app/api/admin/analytics-chat/route.ts

import { openai } from '@ai-sdk/openai'
import { streamText, tool } from 'ai'
import { z } from 'zod'

// Import the query engine directly — no HTTP round-trip
import { routeSurface, SURFACE_CATALOG, type AnalyticsTimeRange } from '../../analytics/route'

// Import domain-specific query functions for deeper tools
import {
  getRevenueBySource,
  getConversionFunnel,
  getContentPurchaseCorrelation,
  getRecentPurchases,
} from '@/lib/analytics-queries'
import { getChannelOverview, getVideoPerformance } from '@/lib/youtube-data'

const ANALYTICS_SYSTEM_PROMPT = `You are the AI Hero analytics agent. You answer questions about revenue, attribution, YouTube performance, traffic, and content effectiveness for a developer education platform.

You have direct access to 21 analytics surfaces and can query them in real-time. When asked a question:
1. Identify which surfaces contain the answer
2. Query them (you can make multiple queries per turn)
3. Cross-reference the data
4. Give a specific, numbers-backed answer

Key context:
- YouTube is the #1 traffic source (~20K sessions/week from youtube.com)
- YouTube Analytics API has a 2-day data delay
- Attribution coverage is incomplete — "dark" revenue has no source attribution
- Shortlinks are the only fully-traced attribution path (click → signup → purchase)
- First-touch attribution (UTMs, referrer, landing page) was recently deployed — historical data won't have it
- Revenue is in USD, stored in the Purchase table
- Video engagement data comes from both Mux (on-site) and YouTube (off-site)

When presenting numbers:
- Always state the time range
- Compare to previous period when possible
- Flag data quality caveats (e.g., attribution coverage %)
- Be direct — Matt wants answers, not caveats`

export const POST = withSkill(async (request: NextRequest) => {
  // Dual auth: device token OR session cookie
  // (same pattern as /api/analytics)
  const { ability } = await authenticateRequest(request)
  if (!ability || ability.cannot('manage', 'all')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { messages } = await request.json()

  const result = streamText({
    model: openai('gpt-4o'),
    system: ANALYTICS_SYSTEM_PROMPT,
    messages,
    tools: {
      // Primary tool: query any analytics surface
      queryAnalytics: tool({
        description: `Query an analytics surface. Surfaces: ${SURFACE_CATALOG.map(s => `${s.name} — ${s.description}`).join('; ')}`,
        parameters: z.object({
          surface: z.enum(SURFACE_CATALOG.map(s => s.name) as [string, ...string[]]),
          range: z.enum(['24h', '7d', '30d', '90d', 'all']).default('30d'),
          limit: z.number().optional().describe('Max results for list surfaces'),
        }),
        execute: async ({ surface, range, limit }) => {
          return routeSurface(surface, range as AnalyticsTimeRange, limit ?? 20)
        },
      }),

      // Comparison tool: same surface, two ranges
      compareRanges: tool({
        description: 'Compare a surface across two time ranges (e.g., this week vs last week)',
        parameters: z.object({
          surface: z.enum(SURFACE_CATALOG.map(s => s.name) as [string, ...string[]]),
          currentRange: z.enum(['24h', '7d', '30d', '90d']),
          previousRange: z.enum(['24h', '7d', '30d', '90d']),
        }),
        execute: async ({ surface, currentRange, previousRange }) => {
          const [current, previous] = await Promise.all([
            routeSurface(surface, currentRange as AnalyticsTimeRange, 20),
            routeSurface(surface, previousRange as AnalyticsTimeRange, 20),
          ])
          return { current, previous, currentRange, previousRange }
        },
      }),

      // Attribution trail: trace a specific user/purchase
      traceAttribution: tool({
        description: 'Trace the full attribution trail for a purchase or user email. Shows: first touch → signup → content consumed → purchase.',
        parameters: z.object({
          email: z.string().optional(),
          purchaseId: z.string().optional(),
        }),
        execute: async ({ email, purchaseId }) => {
          // TODO: implement attribution trail query
          // Joins: User → Purchase → ShortlinkAttribution → ResourceProgress
          return { todo: 'attribution trail not yet implemented' }
        },
      }),

      // Compute derived metrics
      computeMetric: tool({
        description: 'Compute a derived metric: revenue-per-session, cost-per-acquisition, LTV estimate, content-conversion-rate',
        parameters: z.object({
          metric: z.enum([
            'revenue_per_session',
            'youtube_to_purchase_rate',
            'attribution_coverage',
            'content_conversion_rate',
          ]),
          range: z.enum(['7d', '30d', '90d']).default('30d'),
        }),
        execute: async ({ metric, range }) => {
          switch (metric) {
            case 'revenue_per_session': {
              const [revenue, traffic] = await Promise.all([
                routeSurface('summary', range as AnalyticsTimeRange, 1),
                routeSurface('traffic', range as AnalyticsTimeRange, 1),
              ])
              const rev = (revenue as any).totalRevenue ?? 0
              const sessions = (traffic as any).sessions ?? 1
              return { revenuePerSession: rev / sessions, revenue: rev, sessions }
            }
            case 'attribution_coverage':
              return routeSurface('attribution/coverage', range as AnalyticsTimeRange, 1)
            case 'content_conversion_rate':
              return routeSurface('attribution/funnel', range as AnalyticsTimeRange, 1)
            case 'youtube_to_purchase_rate': {
              const [yt, rev] = await Promise.all([
                routeSurface('youtube', range as AnalyticsTimeRange, 1),
                routeSurface('summary', range as AnalyticsTimeRange, 1),
              ])
              const views = (yt as any).viewCount ?? 1
              const purchases = (rev as any).purchaseCount ?? 0
              return { rate: purchases / views, views, purchases }
            }
          }
        },
      }),
    },
    maxSteps: 8,  // Allow multi-hop: query → analyze → query more → synthesize
  })

  return result.toDataStreamResponse()
})
```

### Client Component: AnalyticsChat

Uses ai-elements components with tool result rendering:

```typescript
// apps/ai-hero/src/app/admin/analytics/_components/analytics-chat.tsx
'use client'

import { useChat } from '@ai-sdk/react'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
} from '@/components/ai-elements/prompt-input'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'

export function AnalyticsChat() {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat({
    api: '/api/admin/analytics-chat',
  })

  return (
    <div className="flex h-[500px] flex-col rounded-lg border">
      <Conversation>
        <ConversationContent>
          {messages.map((message) => (
            <Message key={message.id} from={message.role}>
              <MessageContent>
                {message.parts?.map((part, i) => {
                  switch (part.type) {
                    case 'text':
                      return <MessageResponse key={i}>{part.text}</MessageResponse>
                    case 'tool-invocation':
                      return (
                        <Tool key={i}>
                          <ToolHeader>
                            Queried: {part.toolInvocation.toolName}
                            ({part.toolInvocation.args?.surface ?? ''})
                          </ToolHeader>
                          <ToolContent>
                            {part.toolInvocation.state === 'result' && (
                              <ToolOutput>
                                {/* Render chart or table based on surface type */}
                                <ToolResultRenderer
                                  surface={part.toolInvocation.args?.surface}
                                  data={part.toolInvocation.result}
                                />
                              </ToolOutput>
                            )}
                          </ToolContent>
                        </Tool>
                      )
                  }
                })}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput onSubmit={handleSubmit}>
        <PromptInputTextarea
          value={input}
          onChange={handleInputChange}
          placeholder="Ask about revenue, YouTube performance, attribution..."
        />
        <PromptInputSubmit disabled={status !== 'ready'} />
      </PromptInput>
    </div>
  )
}
```

### Tool Result Rendering

When the agent queries a surface, the result renders inline as either a chart or a table depending on the surface type:

```typescript
// apps/ai-hero/src/app/admin/analytics/_components/tool-result-renderer.tsx
'use client'

function ToolResultRenderer({ surface, data }: { surface: string; data: any }) {
  // Timeseries surfaces → line chart (Recharts)
  if (surface?.includes('daily') || surface?.includes('correlation')) {
    return <TimeseriesChart data={data} />
  }

  // List surfaces → sortable table
  if (Array.isArray(data)) {
    return <DataTable data={data} />
  }

  // Summary surfaces → stat cards
  return <SummaryCards data={data} />
}
```

### Suggested prompts (shown in empty state)

```typescript
const SUGGESTED_PROMPTS = [
  "What's our revenue trend this month compared to last?",
  "Which YouTube video drove the most purchases?",
  "What's our attribution coverage? How much revenue is 'dark'?",
  "Show me the full funnel: signups → purchases → conversion rate",
  "What content do buyers watch before purchasing?",
  "Compare this week's YouTube performance to last week",
  "What traffic sources are growing fastest?",
]
```

### File structure for implementation

```
apps/ai-hero/src/
├── app/
│   ├── api/
│   │   └── admin/
│   │       └── analytics-chat/
│   │           └── route.ts          ← streaming chat endpoint
│   └── admin/
│       └── analytics/
│           ├── page.tsx              ← server component (replace current)
│           └── _components/
│               ├── analytics-chat.tsx         ← useChat + ai-elements
│               ├── analytics-dashboard.tsx    ← main layout (client)
│               ├── tool-result-renderer.tsx   ← chart/table/card renderer
│               ├── stat-cards.tsx             ← top-line metrics
│               ├── promoted-metrics.tsx       ← pinnable/reorderable cards
│               ├── surface-explorer.tsx       ← collapsible surface browser
│               ├── attribution-trail.tsx      ← email/purchase lookup
│               ├── timeseries-chart.tsx       ← Recharts wrapper
│               └── data-table.tsx             ← generic sortable table
└── components/
    └── ai-elements/                  ← installed by npx ai-elements@latest
        ├── conversation.tsx
        ├── message.tsx
        ├── prompt-input.tsx
        └── tool.tsx
```

### Implementation order

1. **Install ai-elements components**: `cd apps/ai-hero && pnpm dlx ai-elements@latest add conversation message prompt-input tool`
2. **Chat route** (`/api/admin/analytics-chat`): streamText + tools + dual auth
3. **AnalyticsChat client component**: useChat + ai-elements + tool result rendering
4. **Mount in /admin/analytics page**: alongside existing dashboard content
5. **Tool result renderer**: timeseries charts (Recharts), data tables, summary cards
6. **Attribution trail tool implementation**: server action for user/purchase lookup
7. **Promoted metrics + UserPrefs**: drag-to-reorder, pin/unpin
8. **Surface explorer**: collapsible category browser with inline expansion

---

## Analytics SDK — Type-Safe Design

### The type-level surface registry

Every surface maps to its exact return type. `query()` infers the return type from the surface name at the call site — no casts, no `as`, no `any`.

```typescript
// src/lib/analytics/types.ts

// ─── Branded metric types ────────────────────────────────────────────────────

declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type USD = Brand<number, 'USD'>
export type Count = Brand<number, 'Count'>
export type Percentage = Brand<number, 'Percentage'>
export type Minutes = Brand<number, 'Minutes'>
export type Seconds = Brand<number, 'Seconds'>

// ─── Time ranges ─────────────────────────────────────────────────────────────

export type AnalyticsRange = '24h' | '7d' | '30d' | '90d' | 'all'

// ─── Per-surface result types ────────────────────────────────────────────────

export interface RevenueSummary {
  totalRevenue: USD
  purchaseCount: Count
  avgOrderValue: USD
}

export interface RevenueDaily {
  date: string
  revenue: USD
  count: Count
}

export interface RevenueByProduct {
  productId: string
  productName: string
  revenue: USD
  count: Count
}

export interface RevenueByCountry {
  country: string
  revenue: USD
  count: Count
}

export interface RecentPurchase {
  id: string
  createdAt: Date
  totalAmount: USD
  productName: string
  productId: string
  country: string | null
  couponId: string | null
  userName: string | null
  userEmail: string | null
}

export interface AttributionCount {
  type: string
  count: Count
}

export interface ShortlinkPerformance {
  shortlinkId: string
  slug: string
  url: string
  clicks: Count
}

export interface RevenueBySource {
  source: string
  medium: string
  campaign: string | null
  revenue: USD
  count: Count
}

export interface ConversionFunnel {
  totalSignups: Count
  totalPurchases: Count
  attributedPurchases: Count
  unattributedPurchases: Count
  conversionRate: Percentage
  attributionCoverage: Percentage
}

export interface ContentCorrelation {
  resourceId: string
  purchaserCount: Count
}

export interface AttributionCoverage {
  totalRevenue: USD
  attributedRevenue: USD
  unattributedRevenue: USD
  attributionRate: Percentage
  totalPurchases: Count
}

export interface TrafficOverview {
  sessions: Count
  totalUsers: Count
  newUsers: Count
  pageviews: Count
  avgSessionDuration: Seconds
  bounceRate: Percentage
}

export interface TrafficDaily {
  date: string
  sessions: Count
  users: Count
  pageviews: Count
}

export interface TopPage {
  path: string
  pageviews: Count
  users: Count
  avgDuration: Seconds
}

export interface TrafficSource {
  source: string
  medium: string
  sessions: Count
  users: Count
}

export interface YouTubeChannelOverview {
  subscriberCount: Count
  viewCount: Count
  videoCount: Count
}

export interface YouTubeVideoPerformance {
  videoId: string
  views: Count
  watchMinutes: Minutes
  avgViewDuration: Seconds
  subscribersGained: Count
  likes: Count
  comments: Count
}

export interface YouTubeDaily {
  date: string
  views: Count
  watchMinutes: Minutes
}

export interface YouTubeTrafficSource {
  source: string
  views: Count
  watchMinutes: Minutes
}

export interface TrafficRevenueCorrelation {
  traffic: TrafficDaily[]
  revenue: RevenueDaily[]
}

export interface YouTubeRevenueCorrelation {
  youtube: YouTubeDaily[]
  traffic: TrafficDaily[]
  revenue: RevenueDaily[]
}

// ─── The surface map — THIS IS THE CORE TYPE ─────────────────────────────────

export interface SurfaceMap {
  'summary':                  RevenueSummary
  'revenue/daily':            RevenueDaily[]
  'revenue/products':         RevenueByProduct[]
  'revenue/countries':        RevenueByCountry[]
  'purchases/recent':         RecentPurchase[]
  'attribution':              AttributionCount[]
  'attribution/shortlinks':   ShortlinkPerformance[]
  'attribution/sources':      RevenueBySource[]
  'attribution/funnel':       ConversionFunnel
  'attribution/content':      ContentCorrelation[]
  'attribution/coverage':     AttributionCoverage
  'traffic':                  TrafficOverview
  'traffic/daily':            TrafficDaily[]
  'traffic/pages':            TopPage[]
  'traffic/sources':          TrafficSource[]
  'youtube':                  YouTubeChannelOverview
  'youtube/videos':           YouTubeVideoPerformance[]
  'youtube/daily':            YouTubeDaily[]
  'youtube/sources':          YouTubeTrafficSource[]
  'correlation/traffic-revenue':   TrafficRevenueCorrelation
  'correlation/youtube-revenue':   YouTubeRevenueCorrelation
}

export type SurfaceName = keyof SurfaceMap

// ─── Query options ───────────────────────────────────────────────────────────

export interface QueryOptions {
  range?: AnalyticsRange
  limit?: number
}

// ─── Result envelope ─────────────────────────────────────────────────────────

export type QueryResult<S extends SurfaceName> = {
  ok: true
  surface: S
  range: AnalyticsRange
  data: SurfaceMap[S]
  meta: { queryTimeMs: number; truncated: boolean }
} | {
  ok: false
  surface: S
  error: { message: string; code: string }
  fix: string
}
```

### The SDK: `query<S>()` with inferred return types

```typescript
// src/lib/analytics/index.ts

import type { SurfaceMap, SurfaceName, AnalyticsRange, QueryOptions, QueryResult } from './types'
import { catalog, type SurfaceEntry } from './catalog'

// Provider implementations
import * as database from './providers/database'
import * as ga4 from './providers/ga4'
import * as youtube from './providers/youtube'
import * as mux from './providers/mux'
import * as derived from './providers/derived'

const providers = { database, ga4, youtube, mux, derived } as const

/**
 * Type-safe analytics query. Return type is inferred from the surface name.
 *
 * @example
 * const result = await analytics.query('youtube/videos', { range: '30d' })
 * //    ^? QueryResult<'youtube/videos'>
 * // result.data is YouTubeVideoPerformance[] — no cast needed
 */
export async function query<S extends SurfaceName>(
  surface: S,
  options?: QueryOptions,
): Promise<QueryResult<S>> {
  const range = options?.range ?? '30d'
  const limit = options?.limit ?? 20
  const entry = catalog[surface]
  const startMs = Date.now()

  try {
    const provider = providers[entry.provider]
    const fn = provider[entry.fn as keyof typeof provider] as (
      range: AnalyticsRange,
      limit: number,
    ) => Promise<SurfaceMap[S] | null>

    const data = await fn(range, limit)

    if (data === null) {
      return {
        ok: false,
        surface,
        error: { message: `${entry.provider} is not available`, code: `${entry.provider.toUpperCase()}_UNAVAILABLE` },
        fix: entry.unavailableFix ?? 'Check provider configuration',
      } as QueryResult<S>
    }

    return {
      ok: true,
      surface,
      range,
      data,
      meta: { queryTimeMs: Date.now() - startMs, truncated: Array.isArray(data) && data.length >= limit },
    } as QueryResult<S>
  } catch (error) {
    return {
      ok: false,
      surface,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: 'QUERY_FAILED',
      },
      fix: `The ${surface} query failed. Try a different range or check server logs.`,
    } as QueryResult<S>
  }
}

/**
 * Query multiple surfaces in parallel. Each result is independently typed.
 */
export async function queryMany<S extends SurfaceName>(
  surfaces: S[],
  options?: QueryOptions,
): Promise<{ [K in S]: QueryResult<K> }> {
  const results = await Promise.all(
    surfaces.map(async (s) => [s, await query(s, options)] as const),
  )
  return Object.fromEntries(results) as { [K in S]: QueryResult<K> }
}

/**
 * Get the full surface catalog with descriptions and availability.
 */
export function getCatalog(): SurfaceEntry[] {
  return Object.values(catalog)
}

// Re-export types
export type { SurfaceMap, SurfaceName, AnalyticsRange, QueryOptions, QueryResult } from './types'
```

### The catalog: surface → provider + function routing

```typescript
// src/lib/analytics/catalog.ts

import type { SurfaceName } from './types'

export interface SurfaceEntry {
  name: SurfaceName
  description: string
  category: 'revenue' | 'attribution' | 'traffic' | 'youtube' | 'correlation'
  provider: 'database' | 'ga4' | 'youtube' | 'mux' | 'derived'
  fn: string  // function name in the provider module
  unavailableFix?: string
}

export const catalog: Record<SurfaceName, SurfaceEntry> = {
  'summary':                   { name: 'summary', description: 'Revenue overview: total, purchase count, AOV', category: 'revenue', provider: 'database', fn: 'getRevenueSummary' },
  'revenue/daily':             { name: 'revenue/daily', description: 'Revenue and purchase count per day', category: 'revenue', provider: 'database', fn: 'getRevenueByDay' },
  'revenue/products':          { name: 'revenue/products', description: 'Revenue grouped by product', category: 'revenue', provider: 'database', fn: 'getRevenueByProduct' },
  'revenue/countries':         { name: 'revenue/countries', description: 'Revenue grouped by country', category: 'revenue', provider: 'database', fn: 'getRevenueByCountry' },
  'purchases/recent':          { name: 'purchases/recent', description: 'Last N purchases', category: 'revenue', provider: 'database', fn: 'getRecentPurchases' },
  'attribution':               { name: 'attribution', description: 'Attribution event counts by type', category: 'attribution', provider: 'database', fn: 'getAttributionSummary' },
  'attribution/shortlinks':    { name: 'attribution/shortlinks', description: 'Per-shortlink click performance', category: 'attribution', provider: 'database', fn: 'getShortlinkPerformance' },
  'attribution/sources':       { name: 'attribution/sources', description: 'Revenue by first-touch source/medium/campaign', category: 'attribution', provider: 'database', fn: 'getRevenueBySource' },
  'attribution/funnel':        { name: 'attribution/funnel', description: 'Signup → purchase conversion funnel', category: 'attribution', provider: 'database', fn: 'getConversionFunnel' },
  'attribution/content':       { name: 'attribution/content', description: 'Content consumed by purchasers', category: 'attribution', provider: 'database', fn: 'getContentPurchaseCorrelation' },
  'attribution/coverage':      { name: 'attribution/coverage', description: 'Attributed vs dark revenue', category: 'attribution', provider: 'database', fn: 'getAttributedRevenueSummary' },
  'traffic':                   { name: 'traffic', description: 'GA4 traffic overview', category: 'traffic', provider: 'ga4', fn: 'getTrafficOverview' },
  'traffic/daily':             { name: 'traffic/daily', description: 'GA4 daily sessions', category: 'traffic', provider: 'ga4', fn: 'getSessionsByDay' },
  'traffic/pages':             { name: 'traffic/pages', description: 'Top pages by pageviews', category: 'traffic', provider: 'ga4', fn: 'getTopPages' },
  'traffic/sources':           { name: 'traffic/sources', description: 'Traffic sources', category: 'traffic', provider: 'ga4', fn: 'getTrafficSources' },
  'youtube':                   { name: 'youtube', description: 'Channel overview', category: 'youtube', provider: 'youtube', fn: 'getChannelOverview', unavailableFix: 'Complete OAuth at /api/analytics/youtube-auth' },
  'youtube/videos':            { name: 'youtube/videos', description: 'Per-video performance (2-day delay)', category: 'youtube', provider: 'youtube', fn: 'getVideoPerformance', unavailableFix: 'Complete OAuth at /api/analytics/youtube-auth' },
  'youtube/daily':             { name: 'youtube/daily', description: 'Daily views + watch minutes (2-day delay)', category: 'youtube', provider: 'youtube', fn: 'getChannelTimeseries', unavailableFix: 'Complete OAuth at /api/analytics/youtube-auth' },
  'youtube/sources':           { name: 'youtube/sources', description: 'YouTube traffic sources', category: 'youtube', provider: 'youtube', fn: 'getYouTubeTrafficSources', unavailableFix: 'Complete OAuth at /api/analytics/youtube-auth' },
  'correlation/traffic-revenue':  { name: 'correlation/traffic-revenue', description: 'GA4 sessions + revenue by day', category: 'correlation', provider: 'derived', fn: 'getTrafficRevenueCorrelation' },
  'correlation/youtube-revenue':  { name: 'correlation/youtube-revenue', description: 'YouTube + GA4 + revenue overlay', category: 'correlation', provider: 'derived', fn: 'getYouTubeRevenueCorrelation' },
} as const satisfies Record<SurfaceName, SurfaceEntry>
```

### What the consumer experience looks like

```typescript
// In the chat agent tools:
const result = await analytics.query('youtube/videos', { range: '30d' })
if (result.ok) {
  result.data  // YouTubeVideoPerformance[] — fully typed
  result.data[0].views      // Count (branded number)
  result.data[0].videoId    // string
  result.data[0].watchMinutes // Minutes (branded number)
}

// In the API route:
const result = await analytics.query(surface as SurfaceName, { range, limit })
// result is QueryResult<typeof surface> — discriminated union

// In the dashboard:
const { summary, youtube, funnel } = await analytics.queryMany(
  ['summary', 'youtube', 'attribution/funnel'],
  { range: '30d' },
)
// summary.data is RevenueSummary
// youtube.data is YouTubeChannelOverview
// funnel.data is ConversionFunnel
// All fully typed at the call site
```

### Provider module contract

Each provider exports functions matching this shape:

```typescript
// Every provider function has this signature:
type ProviderFn<T> = (range: AnalyticsRange, limit: number) => Promise<T | null>

// null = provider unavailable (missing credentials, API down)
// Throw = unexpected error (SDK catches and wraps in error envelope)
```

### Migration path

1. Create `src/lib/analytics/` directory structure
2. Move existing functions:
   - `analytics-queries.ts` → `providers/database.ts`
   - `ga4-data.ts` → `providers/ga4.ts`
   - `youtube-data.ts` → `providers/youtube.ts`
   - `mux-data.ts` → `providers/mux.ts`
3. Create `types.ts`, `catalog.ts`, `index.ts`
4. Create `providers/derived.ts` (correlation queries)
5. Rewrite `route.ts` to use `analytics.query()` (~500 lines → ~100 lines)
6. Wire chat agent tools to `analytics.query()`
7. Delete old imports, verify TypeScript is clean
