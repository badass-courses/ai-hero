# AI Hero Analytics — Continuation Prompt

## What was built (this session, 2026-03-22/23)

### Audit & Plan
- `apps/ai-hero/docs/analytics-audit.md` — 1,200+ line comprehensive analytics audit covering current tracking surface, attribution gaps, server-side strategy, YouTube integration, agent-first API design, type-safe SDK design, chat agent architecture, and omnibus dashboard plan

### Analytics SDK (`src/lib/analytics/`)
- **Type-safe SDK** with branded types (USD, Count, Percentage, Minutes, Seconds), SurfaceMap interface mapping 21 surface names to exact return types, QueryResult<S> discriminated union
- **Catalog** (`catalog.ts`): surface → provider routing with `as const satisfies`
- **Providers**: `database.ts`, `ga4.ts`, `youtube.ts`, `derived.ts` — re-export from source files
- **Entry point** (`index.ts`): `query<S>()` and `queryMany()` with inferred return types

### Data Layers
- `src/lib/ga4-measurement.ts` — GA4 Measurement Protocol helper (server-side, ad-block-proof)
- `src/lib/youtube-data.ts` — YouTube Data API v3 + Analytics API v2 via OAuth2 (4 functions, graceful null when token missing)
- `src/utils/first-touch.ts` — Client-side first-touch attribution cookie (UTMs, referrer, landing page, GA client ID)
- `src/components/first-touch-capture.tsx` — Mounted in layout.tsx

### Attribution Wiring
- `shortlink-attribution.ts` — Extended with GA4 Measurement Protocol purchase event
- `signup-attribution.ts` — New Inngest function, fires GA4 sign_up event on USER_CREATED_EVENT
- `packages/core/src/lib/actions/checkout.ts` — Reads ft_attr cookie, passes UTMs/gaClientId/landingPath to Stripe metadata
- `packages/core/src/schemas/stripe/checkout-session-metadata.ts` — Extended with UTM fields

### Event Taxonomy
- `completed: video` → `video_completed`
- `Problem Prompt Copied` → `problem_prompt_copied`
- `nav-link-clicked` → `nav_link_clicked`
- `sl_ref` cookie → `httpOnly: true`

### API (`/api/analytics`)
- 21 surfaces across 5 categories (revenue, attribution, traffic, youtube, correlation)
- Agent-first HATEOAS envelope: root catalog discovery, contextual next_actions with param templates, error codes with fix suggestions
- Dual auth: session cookie + device token
- YouTube surfaces return YOUTUBE_AUTH_MISSING error envelope when token absent

### Chat Agent (`/api/analytics/chat`)
- AI SDK v6 `streamText` with 3 tools: queryAnalytics (21 surfaces), compareRanges, computeMetric
- Uses `@ai-sdk/gateway` with `openai/gpt-5.4` via Vercel AI Gateway
- Dual auth same as analytics API

### Dashboard (`/admin/analytics`)
- Omnibus page with 6 stat cards (Revenue, YouTube, Site Video, Sessions, Attribution, Link Clicks)
- Revenue chart (Recharts area)
- By Country horizontal bar chart (Recharts)
- By Product breakdown with progress bars
- Mux top 10 site videos table
- Shortlinks top 10 with expandable "show more"
- Attribution Trail section (shortlink conversion funnel)
- Recent team purchases (filtered to org purchases)
- API endpoint card with clipboard (URL + agent prompt markdown)
- Chat agent as inline section (needs to become floating widget)

### AI SDK Upgrade
- `ai` v4.2.11 → v6.0.135
- `@ai-sdk/openai` v1.3.6 → v3.0.47
- `@ai-sdk/react` v1.2.5 → v3.0.137
- Added `@ai-sdk/gateway` v3.0.77
- `packages/core`: `CoreMessage` → `ModelMessage`, `textDelta` → `text`
- ai-elements components installed (conversation, message, prompt-input, tool)

### Env Vars Added
- `GA4_MEASUREMENT_API_SECRET` — Vercel + .env.local + agent-secrets
- `AI_GATEWAY_API_KEY` — Vercel (prod/preview/dev) + .env.local + agent-secrets
- `YOUTUBE_ANALYTICS_REFRESH_TOKEN` — Set by Matt via OAuth flow, in Vercel
- `aihero_admin_device_token` — in agent-secrets (joel@egghead.io admin token for API access)

### DB State
- 4,437 valid purchases, 0 with UTM attribution (just shipped, accumulating)
- 6,031 shortlink signup attributions, 739 shortlink purchase attributions (working)
- 29,878 users, 0 with first-touch data (ft_attr cookie just deployed)

## What's left to do

### Immediate (this sprint)
1. ~~**Floating chat widget**~~ — KILLED. Chat removed from dashboard. API route stays at `/api/analytics/chat` for agent use. Replaced with minimal "Copy agent prompt" button.

2. ~~**Dashboard UI polish**~~ — SHIPPED (commit 0368253c):
   - Stat cards: YouTube + Site Video primary metric = watch time
   - New side-by-side top 3 videos: YouTube (thumbnails, titles, watch mins, subs gained, YT links) + Site (Mux playing time, views)
   - Full site videos table sorted by watch time below fold
   - Compressed API card (just link + copy agent prompt)
   - Tighter spacing, consistent card headers, cleaner charts
   - youtube-data.ts: `getVideoPerformanceWithTitles()` batch-resolves IDs → titles/thumbnails
   - DONE

3. ~~**Attribution trail lookup**~~ — SHIPPED (commit 8e4ef708):
   - `traceAttribution()` in analytics-queries.ts walks Click → Signup → Progress → Purchase
   - Wired into chat agent as `traceAttribution` tool (accepts email or purchaseId)
   - Returns sorted timeline with user info

3b. ~~**Period-over-period revenue chart**~~ — SHIPPED (commit 8e4ef708):
   - `getPreviousPeriodRevenueByDay()` fetches prior period of equal length
   - Revenue chart overlays previous period as dashed line, tooltip shows delta %

3c. ~~**Mobile responsive pass**~~ — SHIPPED (commit 8e4ef708):
   - Range selector overflow, thumbnails hidden <sm, flex-wrap metrics, md grid breakpoints, tighter mobile padding

4. **Verify Vercel deploy** — Need to verify `8e4ef708` deployed cleanly.

### Short-term
5. **GA4 conversions** — Mark `sign_up` and `purchase` as conversions in GA4 admin UI (manual, can't be automated from code)

6. **First-touch data verification** — Once a few days of traffic flows through, verify ft_attr cookies are being set and checkout metadata captures UTMs. Query `Purchase.fields` for non-null utmSource.

7. **YouTube correlation chart** — The `correlation/youtube-revenue` surface exists and works locally but isn't rendered in the dashboard yet. Overlay YouTube daily views + GA4 youtube.com sessions + revenue on one Recharts ComposedChart.

8. **Dashboard user prefs** — Store pinned/reordered dashboard sections in UserPrefs table (already exists). Matt can drag cards to customize layout.

### Medium-term
9. **Subscription conversion tracking** — The audit notes that `/thanks/subscription` path needs explicit instrumentation alongside one-time purchases.

10. **Make attribution writes durable** — `recordClick().catch()` in shortlink redirect and `createShortlinkAttribution().catch()` in subscribe route are fire-and-forget. Should be awaited or Inngest-ified.

11. **Replace `@skillrecordings/analytics` track()** — The wrapper sends to 3 dead endpoints (ahoy, fbq, ga). Replace with thin gtag wrapper or remove entirely now that server-side GA4 MP handles conversions.

## Key files

```
apps/ai-hero/src/
├── lib/
│   ├── analytics/              ← Type-safe SDK
│   │   ├── types.ts            (branded types, SurfaceMap, QueryResult<S>)
│   │   ├── catalog.ts          (21 surfaces → provider routing)
│   │   ├── index.ts            (query(), queryMany(), getCatalog())
│   │   └── providers/          (database, ga4, youtube, derived)
│   ├── analytics-queries.ts    ← DB query functions (revenue, attribution)
│   ├── ga4-data.ts             ← GA4 Data API (service account)
│   ├── ga4-measurement.ts      ← GA4 Measurement Protocol (server-side events)
│   ├── youtube-data.ts         ← YouTube API (OAuth2, 4 functions)
│   └── mux-data.ts             ← Mux Data API
├── app/
│   ├── api/analytics/
│   │   ├── route.ts            ← 21-surface REST API with HATEOAS
│   │   ├── chat/route.ts       ← Streaming chat agent (AI SDK v6 + gateway)
│   │   └── youtube-auth/       ← OAuth flow for YouTube
│   └── admin/analytics/
│       ├── page.tsx            ← Server component, parallel data fetch
│       └── _components/
│           ├── omnibus-dashboard.tsx  ← Main dashboard (client)
│           ├── analytics-chat.tsx     ← Chat UI (needs → floating widget)
│           ├── revenue-chart.tsx      ← Recharts area chart
│           └── country-chart.tsx      ← Recharts horizontal bar chart
├── utils/
│   ├── analytics.ts            ← track() wrapper (@skillrecordings/analytics)
│   └── first-touch.ts          ← First-touch attribution cookie
├── components/
│   ├── first-touch-capture.tsx  ← Mounted in layout.tsx
│   └── ai-elements/            ← Vendor components (conversation, message, etc.)
├── inngest/functions/
│   ├── shortlink-attribution.ts ← Purchase attribution + GA4 MP
│   └── signup-attribution.ts    ← Signup GA4 MP event
└── docs/
    ├── analytics-audit.md       ← Full audit + plan (1,200+ lines)
    └── analytics-continuation.md ← This file

packages/core/src/
├── lib/actions/checkout.ts      ← ft_attr cookie → Stripe metadata
├── lib/pricing/stripe-checkout.ts ← UTM fields in CheckoutParams
├── schemas/stripe/checkout-session-metadata.ts ← UTM + gaClientId fields
├── providers/openai.ts          ← ModelMessage (was CoreMessage)
├── inngest/util/streaming-chat-prompt-executor.ts ← ModelMessage
└── types.ts                     ← ModelMessage
```

## Skills to load
- `ai-sdk-core`, `ai-sdk-react`, `ai-sdk-tools` — AI SDK v6 patterns
- `ai-elements` — Chat UI components
- `ai-gateway` — Vercel AI Gateway routing
- `recharts` — Chart components
- `analytics-tracking` — Event naming, tracking plan
- `frontend-design` — Dashboard UI quality
- `next-best-practices`, `next-cache-components` — RSC/caching patterns
- `vercel-composition-patterns` — Component architecture
