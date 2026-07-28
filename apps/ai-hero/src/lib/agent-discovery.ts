import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { env } from '@/env.mjs'
import { getAiCodingDictionary } from '@/lib/ai-coding-dictionary'
import { SKILLS_HERO } from '@/lib/skills-content'
import { sql } from 'drizzle-orm'

export const DISCOVERY_CACHE_CONTROL =
	'public, s-maxage=3600, stale-while-revalidate=86400'
const DEFAULT_DISCOVERY_BASE_URL = 'https://www.aihero.dev'
const DISCOVERY_VERSION = 1

const DISCOVERY_FORMATS = {
	html: 'text/html',
	markdown: 'text/markdown',
	json: 'application/json',
} as const

const DISCOVERY_SURFACES = {
	api: '/api',
	openapi: '/api/openapi.json',
	sitemap: '/sitemap.xml',
	sitemapMarkdown: '/sitemap.md',
	llms: '/llms.txt',
} as const

interface DiscoverySurfaceHint {
	path: string
	description: string
}

interface DiscoveryRouteHint {
	label: string
	humanPath?: string
	markdownPath?: string
	note?: string
}

interface ApiDiscoveryResourceFamily {
	name: string
	visibility: string
	htmlPattern?: string
	markdownPattern?: string
	api?: string
}

const DISCOVERY_SURFACE_HINTS = [
	{
		path: DISCOVERY_SURFACES.api,
		description: 'stable public JSON discovery document',
	},
	{
		path: DISCOVERY_SURFACES.sitemapMarkdown,
		description: 'markdown discovery index',
	},
	{
		path: DISCOVERY_SURFACES.sitemap,
		description: 'XML sitemap for crawlers',
	},
	{
		path: DISCOVERY_SURFACES.llms,
		description: 'short operator hint surface',
	},
] as const satisfies readonly DiscoverySurfaceHint[]

const PUBLIC_ROUTE_HINTS = [
	{
		label: 'Posts and lists',
		humanPath: '/<slug>',
		markdownPath: '/<slug>.md',
	},
	{
		label: 'Workshop lessons',
		humanPath: '/workshops/<module>/<lesson>',
		markdownPath: '/workshops/<module>/<lesson>.md',
		note: 'for free public lessons',
	},
	{
		label: 'Tutorial lessons',
		humanPath: '/tutorials/<module>/<lesson>',
		markdownPath: '/tutorials/<module>/<lesson>.md',
	},
	{
		label: 'Workshop landing pages',
		humanPath: '/workshops/<module>',
		markdownPath: '/workshops/<module>.md',
	},
	{
		label: 'Products',
		humanPath: '/products/<slug>',
		markdownPath: '/products/<slug>.md',
	},
	{
		label: 'Cohorts',
		humanPath: '/cohorts/<slug>',
		markdownPath: '/cohorts/<slug>.md',
	},
	{
		label: 'Events',
		humanPath: '/events/<slug>',
		markdownPath: '/events/<slug>.md',
	},
	{
		label: 'Skills',
		humanPath: '/skills',
		markdownPath: '/skills.md',
		note: 'catalogue, featured skills, editorial guides, and changelog',
	},
	{
		label: 'AI Coding Dictionary',
		humanPath: '/ai-coding-dictionary',
	},
	{
		label: 'AI Coding Dictionary entries',
		humanPath: '/ai-coding-dictionary/<slug>',
	},
] as const satisfies readonly DiscoveryRouteHint[]

const PUBLIC_JSON_API_HINTS = [
	{
		path: DISCOVERY_SURFACES.api,
		description:
			'public discovery document for formats, route families, agent tokens, and next actions',
	},
	{
		path: DISCOVERY_SURFACES.openapi,
		description:
			'OpenAPI 3.1 contract with bearer auth, scope requirements, and token-management schemas',
	},
	{
		path: '/api/search?q=<query>',
		description: 'public search entry point for public content',
	},
	{
		path: '/api/resources?slugOrId=<slug>&type=<type>',
		description: 'structured resource lookup by slug or id',
	},
] as const satisfies readonly DiscoverySurfaceHint[]

const API_DISCOVERY_RESOURCE_FAMILIES = [
	{
		name: 'posts-and-lists',
		htmlPattern: '/:slug',
		markdownPattern: '/:slug.md',
		visibility: 'public',
	},
	{
		name: 'workshop-lessons',
		htmlPattern: '/workshops/:module/:lesson',
		markdownPattern: '/workshops/:module/:lesson.md',
		visibility: 'public/free',
	},
	{
		name: 'tutorial-lessons',
		htmlPattern: '/tutorials/:module/:lesson',
		markdownPattern: '/tutorials/:module/:lesson.md',
		visibility: 'public',
	},
	{
		name: 'workshop-landing-pages',
		htmlPattern: '/workshops/:module',
		markdownPattern: '/workshops/:module.md',
		visibility: 'public',
	},
	{
		name: 'products',
		htmlPattern: '/products/:slug',
		markdownPattern: '/products/:slug.md',
		visibility: 'public',
	},
	{
		name: 'cohorts',
		htmlPattern: '/cohorts/:slug',
		markdownPattern: '/cohorts/:slug.md',
		visibility: 'public',
	},
	{
		name: 'events',
		htmlPattern: '/events/:slug',
		markdownPattern: '/events/:slug.md',
		visibility: 'public',
	},
	{
		name: 'skills',
		htmlPattern: '/skills',
		markdownPattern: '/skills.md',
		visibility: 'public',
	},
	{
		name: 'ai-coding-dictionary',
		htmlPattern: '/ai-coding-dictionary',
		visibility: 'public',
	},
	{
		name: 'ai-coding-dictionary-entries',
		htmlPattern: '/ai-coding-dictionary/:slug',
		visibility: 'public',
	},
	{
		name: 'search',
		api: '/api/search?q=:query',
		visibility: 'public',
	},
	{
		name: 'resource-lookup',
		api: '/api/resources?slugOrId=:slug&type=:type',
		visibility: 'public',
	},
] as const satisfies readonly ApiDiscoveryResourceFamily[]

interface ApiDiscoveryAuthedEndpoint {
	method: string
	path: string
	description: string
}

interface ApiDiscoveryAuthedCapability {
	name: string
	auth: string
	description: string
	endpoints: readonly ApiDiscoveryAuthedEndpoint[]
}

/**
 * Capabilities available to an AUTHENTICATED agent (device token in
 * `Authorization: Bearer`). Advertised so an agent can discover what it can do;
 * every endpoint is gated server-side (401 without a token, 403 without the
 * ability) and this only lists paths/shapes, never private data.
 */
const AGENT_API_CAPABILITIES = [
	{
		name: 'calendar-attendees',
		auth: 'device token (Authorization: Bearer) with `update` on Content',
		description:
			"Manage the Google Calendar guest list for an event — addressed by slug OR id. Add emails the guest a calendar invite; remove emails a cancellation. 409 if the event isn't synced to Google Calendar yet.",
		endpoints: [
			{
				method: 'GET',
				path: '/api/calendar/attendees?slugOrId=',
				description:
					'List the current attendees of an event ({ email, displayName?, responseStatus? }[]). Read-only.',
			},
			{
				method: 'POST',
				path: '/api/calendar/attendees',
				description:
					'Add a person to the guest list ({ slugOrId, email }); Google emails them a calendar invite. 409 if already an attendee.',
			},
			{
				method: 'DELETE',
				path: '/api/calendar/attendees',
				description:
					'Remove a person from the guest list ({ slugOrId, email }); Google emails them a cancellation. Idempotent — returns { removed: false } if they were not on the list.',
			},
		],
	},
] as const satisfies readonly ApiDiscoveryAuthedCapability[]

const AGENT_TOKEN_SCOPES = [
	{
		name: 'content:read',
		status: 'active',
		grants:
			'Privileged read of approved CMS content, including draft, unpublished, private, and unlisted content.',
	},
	{
		name: 'analytics:read',
		status: 'reserved',
		grants:
			'Accepted when minting, but currently grants no endpoint access. Do not assume analytics access.',
	},
	{
		name: 'analytics:chat',
		status: 'reserved',
		grants:
			'Accepted when minting, but currently grants no endpoint access. Do not assume analytics chat access.',
	},
] as const

const AGENT_TOKEN_EXCLUSIONS = [
	{
		capability: 'CMS writes',
		why: 'content:read is read-only; create, update, delete, and processing operations mutate state.',
	},
	{
		capability: 'Raw video and Mux payloads',
		why: 'They expose playable identifiers and media internals. Use the sanitized content projections instead.',
	},
	{
		capability: 'Uploads and signed URLs',
		why: 'They grant storage or processing capabilities, even when the route uses HTTP GET.',
	},
	{
		capability: 'Support memory',
		why: 'It is a separate data domain and may contain customer context.',
	},
	{
		capability: 'Survey and enrollment analytics',
		why: 'They contain responses, commerce aggregates, or personally identifying fields rather than CMS content.',
	},
] as const

const DISCOVERY_NEXT_ACTIONS = [
	'Read /api/openapi.json for the complete bearer-auth and per-operation scope contract.',
	'Read /sitemap.md for a markdown-oriented discovery index.',
	'Read /llms.txt for a short operator-oriented summary.',
	'Use explicit .md twins for low-token public content retrieval.',
	'Use /api/search or /api/resources for structured JSON reads.',
] as const

export interface PublicDiscoveryResource {
	title: string
	url: string
	type: string
}

export function getDiscoveryBaseUrl() {
	return normalizeDiscoveryBaseUrl(
		env.COURSEBUILDER_URL || env.NEXT_PUBLIC_URL || DEFAULT_DISCOVERY_BASE_URL,
	)
}

function normalizeDiscoveryBaseUrl(baseUrl: string) {
	return baseUrl.replace(/\/$/, '')
}

function toAbsoluteDiscoveryPath(baseUrl: string, path: string) {
	return `${normalizeDiscoveryBaseUrl(baseUrl)}${path}`
}

function formatSurfaceHints(
	baseUrl: string,
	surfaceHints: readonly DiscoverySurfaceHint[],
	connector: '—' | '->',
) {
	return surfaceHints
		.map(({ path, description }) => {
			const absolutePath = toAbsoluteDiscoveryPath(baseUrl, path)
			return connector === '—'
				? `- \`${absolutePath}\` — ${description}`
				: `- ${absolutePath} -> ${description}`
		})
		.join('\n')
}

function formatHumanRouteHints(
	baseUrl: string,
	routeHints: readonly DiscoveryRouteHint[],
) {
	return routeHints
		.map(({ label, humanPath, note }) => {
			const absolutePath = toAbsoluteDiscoveryPath(baseUrl, humanPath || '/')
			return `- ${label}: \`${absolutePath}\`${note ? ` ${note}` : ''}`
		})
		.join('\n')
}

function formatMarkdownRouteHints(
	baseUrl: string,
	routeHints: readonly DiscoveryRouteHint[],
) {
	return routeHints
		.filter((routeHint) => Boolean(routeHint.markdownPath))
		.map(({ label, markdownPath, note }) => {
			const absolutePath = toAbsoluteDiscoveryPath(baseUrl, markdownPath || '/')
			return `- ${label}: \`${absolutePath}\`${note ? ` ${note}` : ''}`
		})
		.join('\n')
}

function buildAgentTokenDiscovery(baseUrl: string) {
	const normalizedBaseUrl = normalizeDiscoveryBaseUrl(baseUrl)
	const tokenCollectionUrl = `${normalizedBaseUrl}/api/personal-access-tokens`

	return {
		whatTheyAre:
			'Agent tokens are scoped aih_pat_* bearer credentials minted by an admin for non-human callers. Their ability comes only from scopes, never from the owner roles.',
		docs: `${normalizedBaseUrl}/api`,
		openapi: `${normalizedBaseUrl}/api/openapi.json`,
		presentation: {
			header: 'Authorization: Bearer AGENT_TOKEN',
			note: 'Send the token in the Authorization header. Never put it in a URL or query string.',
		},
		tokenKinds: [
			{
				kind: 'scoped agent token',
				shape: 'aih_pat_*',
				use: 'Approved scope-derived reads. A content:read token cannot mint, list, or revoke tokens and cannot write content.',
			},
			{
				kind: 'admin device token',
				shape: 'opaque bearer token',
				use: 'Administrative abilities, including minting, listing, and revoking the caller’s agent tokens.',
			},
		],
		management: {
			requires:
				'An admin device token with manage all ability. Operations are mint-for-self and owned-token-only.',
			mint: {
				method: 'POST',
				path: '/api/personal-access-tokens',
				note: 'The 201 response returns the complete token exactly once. Store it immediately.',
			},
			list: {
				method: 'GET',
				path: '/api/personal-access-tokens',
				note: 'Returns safe metadata only; raw tokens and token hashes are never listed.',
			},
			revoke: {
				method: 'DELETE',
				path: '/api/personal-access-tokens/{id}',
				note: 'Idempotent immediate kill switch for an owned token.',
			},
			curl: {
				mint: `curl -X POST '${tokenCollectionUrl}' -H 'Authorization: Bearer ADMIN_DEVICE_TOKEN' -H 'Content-Type: application/json' --data '{"name":"content-reader","scopes":["content:read"]}'`,
				mintWithExpiry: `curl -X POST '${tokenCollectionUrl}' -H 'Authorization: Bearer ADMIN_DEVICE_TOKEN' -H 'Content-Type: application/json' --data '{"name":"temporary-content-reader","scopes":["content:read"],"expiresAt":"2099-01-01T00:00:00Z"}'`,
				list: `curl '${tokenCollectionUrl}' -H 'Authorization: Bearer ADMIN_DEVICE_TOKEN'`,
				revoke: `curl -X DELETE '${tokenCollectionUrl}/TOKEN_ID' -H 'Authorization: Bearer ADMIN_DEVICE_TOKEN'`,
				read: `curl '${normalizedBaseUrl}/api/posts' -H 'Authorization: Bearer AGENT_TOKEN'`,
			},
		},
		scopes: AGENT_TOKEN_SCOPES.map((scope) => ({ ...scope })),
		privilegedRead: {
			scope: 'content:read',
			includes:
				'Approved posts, lessons, lesson solutions, sanitized resources, product structure, search results, and survey definitions, including draft, unpublished, private, and unlisted content.',
			excludes: AGENT_TOKEN_EXCLUSIONS.map((exclusion) => ({ ...exclusion })),
		},
		lifecycle: {
			expiresAt:
				'Optional at mint and must be a future RFC 3339 timestamp. Omit it for no automatic expiry.',
			revocation:
				'Revoke by token id for an immediate kill switch. Revoked and expired tokens authenticate as invalid.',
			lastUsedAt:
				'Successful verification updates lastUsedAt so admins can audit whether a token is active.',
		},
		errors: {
			'401':
				'The bearer credential is missing, malformed, invalid, expired, or revoked. Some legacy content-read handlers also use 401 when a valid token lacks Content read ability; if the token is known-valid, inspect its scopes before retrying.',
			'403':
				'The credential is valid but its scopes or abilities exclude this operation. content:read never grants writes, Mux payloads, signed URLs, memory, or analytics. Do not retry without a different authorized credential.',
			docsField:
				'Auth-related error bodies point back to /api when their existing envelope permits it.',
		},
	}
}

function formatPublicDiscoveryResources(resources: PublicDiscoveryResource[]) {
	return resources.length
		? resources
				.map(
					(resource) =>
						`- [${resource.title}](${resource.url}) (${resource.type})`,
				)
				.join('\n')
		: '- No public discovery resources are available right now.'
}

export function buildApiDiscoveryDocument(baseUrl = getDiscoveryBaseUrl()) {
	const normalizedBaseUrl = normalizeDiscoveryBaseUrl(baseUrl)

	return {
		version: DISCOVERY_VERSION,
		name: 'AI Hero Public API Discovery',
		baseUrl: normalizedBaseUrl,
		formats: DISCOVERY_FORMATS,
		discovery: { ...DISCOVERY_SURFACES },
		resources: API_DISCOVERY_RESOURCE_FAMILIES.map((resourceFamily) => ({
			...resourceFamily,
		})),
		authenticated: {
			note: 'Bearer credentials may be scoped aih_pat_* agent tokens or admin device tokens. A 403 means the credential is valid but excluded from the operation. A 401 usually means invalid, expired, or revoked; legacy content reads may also return 401 when a valid token lacks Content read ability.',
			capabilities: AGENT_API_CAPABILITIES.map((capability) => ({
				...capability,
				endpoints: capability.endpoints.map((endpoint) => ({ ...endpoint })),
			})),
		},
		agentTokens: buildAgentTokenDiscovery(normalizedBaseUrl),
		nextActions: [...DISCOVERY_NEXT_ACTIONS],
	}
}

export function buildLlmsTxtDocument(baseUrl = getDiscoveryBaseUrl()) {
	const normalizedBaseUrl = normalizeDiscoveryBaseUrl(baseUrl)
	const humanRoutes = formatHumanRouteHints(
		normalizedBaseUrl,
		PUBLIC_ROUTE_HINTS,
	)
	const markdownRoutes = formatMarkdownRouteHints(
		normalizedBaseUrl,
		PUBLIC_ROUTE_HINTS,
	)

	return `AI Hero public discovery

Base URL: ${normalizedBaseUrl}

Start here:
${formatSurfaceHints(normalizedBaseUrl, DISCOVERY_SURFACE_HINTS, '->')}

Human route families:
${humanRoutes}

Markdown twins:
${markdownRoutes}

Public JSON APIs:
${formatSurfaceHints(normalizedBaseUrl, PUBLIC_JSON_API_HINTS, '->')}

Agent tokens:
- Full guide: ${normalizedBaseUrl}/api
- OpenAPI contract: ${normalizedBaseUrl}/api/openapi.json
- Present any bearer as: Authorization: Bearer TOKEN
- Scoped agent tokens start with aih_pat_. Admin device tokens are separate opaque bearer credentials.
- Admin device tokens can POST/GET ${normalizedBaseUrl}/api/personal-access-tokens and DELETE ${normalizedBaseUrl}/api/personal-access-tokens/TOKEN_ID.
- Mint returns the complete agent token once. Optional expiresAt defaults to no automatic expiry; revocation is the kill switch.
- Active scope: content:read. It includes approved draft, unpublished, private, and unlisted CMS reads.
- Reserved scopes analytics:read and analytics:chat currently grant no endpoint access.
- content:read excludes every write, raw Mux/video payloads, uploads and signed URLs, support memory, survey analytics, and enrollment analytics.
- 401 usually means the credential is missing, invalid, expired, or revoked; legacy content reads may also use 401 when a valid token lacks Content read ability. 403 means the credential is valid but excluded from that operation. Read the docs field and ${normalizedBaseUrl}/api before retrying.

Mint example (placeholder credential):
curl -X POST '${normalizedBaseUrl}/api/personal-access-tokens' -H 'Authorization: Bearer ADMIN_DEVICE_TOKEN' -H 'Content-Type: application/json' --data '{"name":"content-reader","scopes":["content:read"]}'

Read example (placeholder credential):
curl '${normalizedBaseUrl}/api/posts' -H 'Authorization: Bearer AGENT_TOKEN'

Formats:
- HTML by default
- Markdown via explicit .md twins on supported public content
- JSON discovery via /api

Notes:
- Discovery surfaces only reference public or free content.
- Existing Accept: text/markdown negotiation still works on the currently supported post and lesson routes.
`
}

export function buildSitemapMarkdownDocument({
	baseUrl = getDiscoveryBaseUrl(),
	resources,
}: {
	baseUrl?: string
	resources: PublicDiscoveryResource[]
}) {
	const normalizedBaseUrl = normalizeDiscoveryBaseUrl(baseUrl)
	const humanUrls = formatHumanRouteHints(normalizedBaseUrl, PUBLIC_ROUTE_HINTS)
	const markdownRoutes = formatMarkdownRouteHints(
		normalizedBaseUrl,
		PUBLIC_ROUTE_HINTS,
	)
	const publicJsonApis = formatSurfaceHints(
		normalizedBaseUrl,
		PUBLIC_JSON_API_HINTS,
		'—',
	)
	const indexedPublicExamples = formatPublicDiscoveryResources(resources)

	return `# AI Hero Public Discovery

Version: ${DISCOVERY_VERSION}

AI Hero exposes public content in HTML by default, explicit \`.md\` twins for supported public route families, and JSON discovery via [\`/api\`](${normalizedBaseUrl}/api).

## Discovery surfaces

- [\`/api\`](${normalizedBaseUrl}/api) — stable public JSON discovery document
- [\`/llms.txt\`](${normalizedBaseUrl}/llms.txt) — lightweight operator hint surface
- [\`/sitemap.xml\`](${normalizedBaseUrl}/sitemap.xml) — XML sitemap for crawlers
- [\`/sitemap.md\`](${normalizedBaseUrl}/sitemap.md) — markdown discovery index

## Human URLs

${humanUrls}

### Indexed public examples

${indexedPublicExamples}

## Markdown twins

${markdownRoutes}
- Existing \`Accept: text/markdown\` negotiation is still supported on the currently supported post and lesson HTML routes.

## Public JSON APIs

${publicJsonApis}

## Usage

\`\`\`bash
curl ${normalizedBaseUrl}/api
curl ${normalizedBaseUrl}/llms.txt
curl ${normalizedBaseUrl}/sitemap.md
curl ${normalizedBaseUrl}/sitemap.xml
curl ${normalizedBaseUrl}/some-post-slug.md
curl ${normalizedBaseUrl}/skills.md
curl ${normalizedBaseUrl}/workshops/module-slug/lesson-slug.md
curl ${normalizedBaseUrl}/tutorials/module-slug/lesson-slug.md
curl ${normalizedBaseUrl}/workshops/module-slug.md
curl ${normalizedBaseUrl}/products/product-slug.md
curl ${normalizedBaseUrl}/cohorts/cohort-slug.md
curl ${normalizedBaseUrl}/events/event-slug.md
curl "${normalizedBaseUrl}/api/search?q=agentic+coding"
curl "${normalizedBaseUrl}/api/resources?slugOrId=some-post-slug&type=post"
curl -H 'Accept: text/markdown' ${normalizedBaseUrl}/some-post-slug
\`\`\`
`
}

export async function getPublicDiscoveryResources(): Promise<
	PublicDiscoveryResource[]
> {
	const baseUrl = getDiscoveryBaseUrl()

	const workshopItems = await db.execute(sql`
    SELECT DISTINCT
      workshop.id AS workshop_id,
      workshop.type AS workshop_type,
      workshop.fields->>'$.slug' AS workshop_slug,
      workshop.fields->>'$.title' AS workshop_title,
      COALESCE(sections.id, top_level_lessons.id) AS section_or_lesson_id,
      COALESCE(sections.fields->>'$.slug', top_level_lessons.fields->>'$.slug') AS section_or_lesson_slug,
      COALESCE(sections.fields->>'$.title', top_level_lessons.fields->>'$.title') AS section_or_lesson_title,
      CASE
        WHEN COALESCE(sections.id, top_level_lessons.id) IS NULL THEN workshop.type
        WHEN lessons.id IS NULL THEN top_level_lessons.type
        ELSE lessons.type
      END AS item_type,
      lessons.id AS lesson_id,
      lessons.fields->>'$.slug' AS lesson_slug,
      lessons.fields->>'$.title' AS lesson_title,
      COALESCE(lesson_relations.metadata->>'$.tier', section_relations.metadata->>'$.tier', top_level_lesson_relations.metadata->>'$.tier') AS tier
    FROM ${contentResource} AS workshop
    LEFT JOIN ${contentResourceResource} AS section_relations
      ON workshop.id = section_relations.resourceOfId
    LEFT JOIN ${contentResource} AS sections
      ON sections.id = section_relations.resourceId AND sections.type = 'section'
    LEFT JOIN ${contentResourceResource} AS lesson_relations
      ON sections.id = lesson_relations.resourceOfId
    LEFT JOIN ${contentResource} AS lessons
      ON lessons.id = lesson_relations.resourceId AND (lessons.type = 'lesson' OR lessons.type = 'exercise')
    LEFT JOIN ${contentResourceResource} AS top_level_lesson_relations
      ON workshop.id = top_level_lesson_relations.resourceOfId
    LEFT JOIN ${contentResource} AS top_level_lessons
      ON top_level_lessons.id = top_level_lesson_relations.resourceId
      AND (top_level_lessons.type = 'lesson' OR top_level_lessons.type = 'exercise')
    WHERE
      (workshop.type = 'workshop' OR workshop.type = 'tutorial')
      AND workshop.fields->>'$.state' = 'published'
      AND workshop.fields->>'$.visibility' = 'public'
  `)

	const otherContent = await db.execute(sql`
    SELECT
      cr.type,
      cr.fields->>'$.slug' AS slug,
      cr.fields->>'$.title' AS title
    FROM ${contentResource} cr
    WHERE
      cr.type IN ('post', 'list')
      AND cr.fields->>'$.state' = 'published'
      AND cr.fields->>'$.visibility' = 'public'
      AND cr.deletedAt IS NULL
    ORDER BY cr.type, cr.updatedAt DESC
  `)

	const dictionary = await getAiCodingDictionary()
	const resourcesByUrl = new Map<string, PublicDiscoveryResource>()

	const addResource = (resource: PublicDiscoveryResource) => {
		if (!resourcesByUrl.has(resource.url)) {
			resourcesByUrl.set(resource.url, resource)
		}
	}

	addResource({
		title: SKILLS_HERO.title,
		url: `${baseUrl}/skills`,
		type: 'skills',
	})

	addResource({
		title: 'AI Coding Dictionary',
		url: `${baseUrl}/ai-coding-dictionary`,
		type: 'dictionary',
	})

	dictionary.entries.forEach((entry) => {
		addResource({
			title: `${entry.title} | AI Coding Dictionary`,
			url: `${baseUrl}/ai-coding-dictionary/${entry.slug}`,
			type: 'dictionary-entry',
		})
	})

	otherContent.rows.forEach((item: any) => {
		addResource({
			title: item.title,
			url: `${baseUrl}/${item.slug}`,
			type: item.type,
		})
	})

	workshopItems.rows.forEach((item: any) => {
		if (
			(item.item_type === 'lesson' || item.item_type === 'exercise') &&
			item.tier === 'free'
		) {
			const lessonSlug = item.lesson_slug || item.section_or_lesson_slug
			if (lessonSlug) {
				addResource({
					title: `${item.workshop_title}: ${item.lesson_title || item.section_or_lesson_title}`,
					url: `${baseUrl}/${item.workshop_type}s/${item.workshop_slug}/${lessonSlug}`,
					type: 'lesson',
				})
			}
		}
	})

	return [...resourcesByUrl.values()].sort((left, right) =>
		left.url.localeCompare(right.url),
	)
}
