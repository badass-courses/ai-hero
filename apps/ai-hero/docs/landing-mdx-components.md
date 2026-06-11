# Landing MDX Components

Reference for all components available in `content/landing.md`. Edit the
markdown file, save, refresh — the page recompiles on every request.

The MDX is compiled by `src/utils/compile-mdx.tsx`; the landing-specific
component map lives in `src/app/page.tsx`.

---

## `<Hero />`

Top-of-page header. Stacks left-side text against a right-side video or image.

| Prop              | Type     | Notes                                                                                    |
| ----------------- | -------- | ---------------------------------------------------------------------------------------- |
| `h1`              | `string` | Supports `**bold**` and inline HTML (`<br />`).                                          |
| `h2`              | `string` | Subtitle. Same markdown support.                                                         |
| `videoResourceId` | `string` | Post slug, post id, or videoResource id. Falls back to `/landing/hero@2x.png` if absent. |

```mdx
<Hero
	h1="Become a<br />**Real** AI Hero"
	h2="with Matt Pocock"
	videoResourceId="my-claude-code-cohort-a-teaser"
/>
```

When `videoResourceId` resolves to a Mux playback id, the hero renders a muted
autoplaying preview that opens the full video in a dialog on click. When it
doesn't, the static image is shown.

---

## `<Resource />`

The workhorse. One component, type-aware. Auto-detects whether the resource is a
cohort, workshop, tutorial, post, or external link and renders accordingly.

### By slug (recommended)

```mdx
<Resource slugOrId="ai-engineer-roadmap" />
<Resource slugOrId="my-grill-me-skill-has-gone-viral" />
<Resource slugOrId="ai-engineer-roadmap" badge="Start here" />
```

### Inline (no DB lookup)

```mdx
<Resource
	title='"Software Fundamentals Matter More Than Ever" — Matt Pocock'
	href="https://www.youtube.com/watch?v=v4F1gFy-hqg"
	variant="card"
/>
```

### Props

| Prop          | Type                | Notes                                                                                                                                             |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slugOrId`    | `string`            | Either the resource's slug or id. Auto-detects type and fetches everything needed.                                                                |
| `title`       | `string`            | Required when no `slugOrId`. Otherwise overrides the resolved title.                                                                              |
| `description` | `string`            | Markdown-supported. Optional.                                                                                                                     |
| `href`        | `string`            | Required when no `slugOrId`. External `https://…` opens in a new tab.                                                                             |
| `image`       | `string`            | URL. Override the resolved cover image.                                                                                                           |
| `badge`       | `string`            | Editorial pill that wins over auto-defaults (discount badge, etc.). Use sparingly — `"Start here"`, `"New"`, `"Featured"`.                        |
| `variant`     | `'row'` \| `'card'` | `'row'` (default) is the image-on-side row used in main sections. `'card'` is the vertical card used inside `<ResourceGrid>` for the latest grid. |

### What renders for which type

| Type                      | Image                                                          | Type label                | Auto badge                                 | Price line | Notes                                                         |
| ------------------------- | -------------------------------------------------------------- | ------------------------- | ------------------------------------------ | ---------- | ------------------------------------------------------------- |
| `cohort`                  | `fields.image`                                                 | `Cohort · Starts Jun 15`  | `<DiscountBadge>` if active default coupon | yes        | PPP not eligible                                              |
| `workshop`                | `fields.image`                                                 | (none, can be re-enabled) | `<DiscountBadge>` if active default coupon | yes        | PPP eligible label appears next to price for eligible regions |
| `tutorial`                | `fields.image`                                                 | (none, can be re-enabled) | none                                       | no         | Always free, no product                                       |
| `post` (with video)       | Auto Mux thumbnail (uses `thumbnailTime`)                      | none                      | none                                       | no         | Hover does not autoplay (cards do, rows don't)                |
| `post` (with cover image) | `fields.image` / `fields.coverImage`                           | none                      | none                                       | no         |                                                               |
| `post` (no media)         | `bg-stripes` placeholder                                       | none                      | none                                       | no         |                                                               |
| Inline external link      | YouTube thumbnail (auto-derived) if YouTube href, else nothing | none                      | none                                       | no         | Opens in new tab                                              |

If a `slugOrId` doesn't resolve or the resource isn't `state=published` and
`visibility=public`, the component renders nothing and logs a warning.

---

## `<UpcomingCohort />`

Auto-picks the next purchasable cohort and renders it as a `<Resource>` row.

```mdx
<UpcomingCohort />
```

No props. Rules:

- Filters cohorts where the attached Product is currently in its enrollment
  window
  (`product.fields.openEnrollment <= now <= product.fields.closeEnrollment`).
- Sorts by `cohort.fields.startsAt` ascending, takes the first.
- Renders nothing if no cohort matches.

To feature a specific cohort regardless of the picker rule, use
`<Resource slugOrId="cohort-slug" />`.

---

## `<ResourceGrid>`

Wraps card-variant `<Resource>`s into a 1/2/3-column grid (responsive). Used for
the "latest posts/videos" section. Auto-fills partial rows with empty filler
cells so the gap-px borders look clean.

```mdx
<ResourceGrid>
	<Resource slugOrId="my-grill-me-skill-has-gone-viral" variant="card" />
	<Resource
		slugOrId="real-world-feature-build-with-claude-code"
		variant="card"
	/>
	<Resource
		title='"Software Fundamentals Matter More Than Ever" — Matt Pocock'
		href="https://www.youtube.com/watch?v=v4F1gFy-hqg"
		variant="card"
	/>
</ResourceGrid>
```

---

## `<Manifesto>`

Two-column band: large headline on the left, prose on the right. Use once near
the top of the page.

| Prop       | Type     | Notes                                          |
| ---------- | -------- | ---------------------------------------------- |
| `headline` | `string` | Required.                                      |
| children   |          | Markdown — paragraphs, links, etc. all render. |

```mdx
<Manifesto headline="Most AI engineering isn't engineering yet.">

There's a class of code that ships to production, and a class that lives on
someone's laptop in a notebook…

Real AI Engineering is the part nobody tweets about.

</Manifesto>
```

(Blank lines around children matter — MDX treats them as paragraph breaks.)

---

## `<AboutMatt>`

Two-column band tailored for the bio block at the bottom of the page. Photo on
the left, prose on the right.

| Prop       | Type     | Notes               |
| ---------- | -------- | ------------------- |
| `headline` | `string` | Required.           |
| children   |          | Markdown supported. |

```mdx
<AboutMatt headline="Hi, I'm Matt Pocock">

Before creating AI Hero, I created Total TypeScript - the industry standard
course for learning TS.

</AboutMatt>
```

---

## `<Testimonial>`

Quote with attributed author and avatar.

| Prop           | Type     | Notes                               |
| -------------- | -------- | ----------------------------------- |
| `authorName`   | `string` | Required.                           |
| `authorAvatar` | `string` | URL to a square image.              |
| children       |          | The quote, supports `**emphasis**`. |

```mdx
<Testimonial
	authorName="Guillermo Rauch — Vercel CEO"
	authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1737463838/workshops/page-6z2ir/qxwhr72flnhn571y4cvg.jpg"
>

"Matt is one of the best developer educators in the world."

</Testimonial>
```

---

## `<NewsletterSection>`

Horizontal band wrapping the slim subscribe form.

| Prop       | Type     | Notes                                 |
| ---------- | -------- | ------------------------------------- |
| `heading`  | `string` | Optional headline above the form.     |
| `subTitle` | `string` | Optional subhead under the headline.  |
| children   |          | Should always be `<NewsletterCta />`. |

```mdx
<NewsletterSection
	heading="Get the next one in your inbox"
	subTitle="Join over 54,000 Developers Becoming AI Heroes"
>
	<NewsletterCta />
</NewsletterSection>
```

`<NewsletterCta />` takes no props — it renders the slim email-signup form.

---

## `<Prose>`

Banded long-form copy block — use when you want to drop several paragraphs of
prose between full-bleed sections without it looking like a leak. Constrained
line-length, padded gutters, prose typography.

| Prop     | Type | Notes                                              |
| -------- | ---- | -------------------------------------------------- |
| children |      | Markdown — paragraphs, lists, links, code, quotes. |

```mdx
<Prose>

Real AI engineering is about more than wiring an LLM into a button. It's about
shipping systems you can debug, observe, and evolve.

This site is for engineers who want to learn that work — and stop pretending the
rest of it doesn't matter.

- Evals as a first-class concern
- Observability that survives prod
- Models you can swap with one config change

</Prose>
```

Inside `<Prose>`, use `### h3` (and below) for sub-headings — not `## h2`. The
top-level `## h2` is overridden globally to render as `<SectionHeading>`, which
has its own full-bleed styling that breaks the prose container's flow.

`**bold**` inside `<Prose>` will still render as `<YellowStrong>` (yellow
accent) because of the global override. If you want plain bold inside prose, use
HTML: `<b>like this</b>`.

---

## Markdown overrides

Two mappings are layered on top of standard markdown:

| Source markdown                            | Renders as                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `## Some heading`                          | `<SectionHeading>` — large left-aligned section title with consistent spacing.            |
| `**emphasis**` (in a heading or paragraph) | `<YellowStrong>` — bold + yellow accent. Use it sparingly to highlight a specific phrase. |

Use `<br />` for explicit line breaks inside a `## heading` (rehype-raw is on).

```mdx
## Level up your coding practice with **Real AI Engineering**

## New to AI?<br />Start here to nail the basics
```

---

## Patterns

### Featuring an upcoming cohort + supporting workshops

```mdx
<UpcomingCohort />
<Resource slugOrId="ai-engineer-roadmap" badge="Start here" />
<Resource slugOrId="vercel-ai-sdk-mastery" />
```

### Mixing posts and tutorials in one section

```mdx
## New to AI? Start here

<Resource slugOrId="what-is-an-ai-engineer" />
<Resource slugOrId="what-are-llms-used-for" />
<Resource slugOrId="model-context-protocol-tutorial" />
```

### Latest posts grid

```mdx
## Latest posts

<ResourceGrid>
	<Resource slugOrId="post-slug-1" variant="card" />
	<Resource slugOrId="post-slug-2" variant="card" />
	<Resource slugOrId="post-slug-3" variant="card" />
</ResourceGrid>
```

---

## Finding slugs

Use `https://aihero.dev/sitemap.md` for the canonical list of public resources
with their slugs and types. The search API at `/api/search?q=…` is also useful
for finding cohorts/workshops/tutorials that aren't yet in the sitemap (private
or in-progress).

```bash
curl -sL 'https://www.aihero.dev/api/search?q=workshop'
curl -sL 'https://www.aihero.dev/api/search?q=tutorial'
curl -sL 'https://www.aihero.dev/api/search?q=cohort'
```

---

## Rendering errors

The page never crashes from MDX errors — invalid components or unresolved slugs
silently log warnings (`landing.X.missing`, `draft.resource.missing`). Check
Axiom for `landing.*` events when something's expected to render but doesn't.

---

## Pages API

The MDX body for landing-style pages is editable over HTTP. Source:
`src/app/api/pages/route.ts`.

### Endpoints

| Method | Path                               | Auth                              | Notes                              |
| ------ | ---------------------------------- | --------------------------------- | ---------------------------------- |
| `GET`  | `/api/pages`                       | admin (`manage all` ability)      | List all pages.                    |
| `GET`  | `/api/pages?slugOrId=<slug-or-id>` | admin                             | Fetch one page by slug or id.      |
| `PUT`  | `/api/pages?id=<id>`               | content editor (`update Content`) | Update fields (body, title, etc.). |

CORS is open; auth via session cookie or bearer token (matches the rest of the
API surface).

### Editable fields

The `PUT` body must look like `{ "fields": { … } }`. Allowed keys:

| Key           | Type                                                      | Notes                                                    |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `body`        | `string` \| `null`                                        | The MDX source. This is what controls the rendered page. |
| `title`       | `string` (2–90 chars)                                     | Editing the title regenerates the slug suffix.           |
| `description` | `string`                                                  |                                                          |
| `slug`        | `string`                                                  | Override the auto-generated slug.                        |
| `state`       | `'draft'` \| `'published'` \| `'archived'` \| `'deleted'` |                                                          |
| `visibility`  | `'public'` \| `'private'` \| `'unlisted'`                 |                                                          |

All keys are optional — send only what you're changing.

### Editing the landing page

The landing page body is stored as a `contentResource` of type `page`.

```bash
# Fetch current body
curl -sL 'https://www.aihero.dev/api/pages?slugOrId=<page-id>' \
	-H 'Authorization: Bearer <token>'

# Update the MDX body
curl -X PUT 'https://www.aihero.dev/api/pages?id=<page-id>' \
	-H 'Authorization: Bearer <token>' \
	-H 'Content-Type: application/json' \
	-d '{
		"fields": {
			"body": "<Hero h1=\"…\" />\n\n## …"
		}
	}'
```

Successful PUT revalidates the `pages` cache tag — the next page render picks up
the new MDX automatically.

### Discovery from your agent

Pair the API with `https://aihero.dev/sitemap.md` to look up resource slugs
before composing MDX. Workflow:

1. `curl https://www.aihero.dev/sitemap.md` → list of all public resources with
   their types and slugs.
2. `curl https://www.aihero.dev/api/search?q=<term>` for resources not yet in
   the sitemap (e.g. cohorts, workshops not yet public).
3. Compose the new MDX using slugs from steps 1–2 plus the components documented
   above.
4. `PUT /api/pages?id=<page-id>` with the new body.
