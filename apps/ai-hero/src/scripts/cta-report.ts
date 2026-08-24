import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import * as schema from '@/db/schema'
import { contentResource } from '@/db/schema'
import {
	buildPostAskInventories,
	EXPECTED_BODY_CTA_DEFECTS,
	scanBodyAuthoredCtas,
	TOP_ORGANIC_TARGETS,
	type AskInventory,
	type EmailAsk,
	type TemplateCta,
	type TopOrganicTarget,
	ZERO_ASK_VIDEO_DEFECT_SLUGS,
} from '@/lib/cta-report'
import { resolvePostCta } from '@/lib/post-cta'
import { and, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'

import { organicOpportunityCtaBySlug } from '../app/(content)/_components/organic-opportunity-cta'

type Mode = 'build' | 'on-demand' | 'scheduled'
type Scope = 'all' | 'top-organic'

type ResourceRecord = {
	id: string
	type: string
	fields: Record<string, unknown> | null
	updatedAt: Date | null
	resources:
		| {
				resource: {
					id: string
					type: string
				}
		  }[]
		| null
}

type AskModel = AskInventory & {
	humanReviewFlags: string[]
}

type ReportRow = {
	path: string
	clicks: number | null
	resourceId: string | null
	resourceType: string
	slug: string
	title: string | null
	state: string | null
	visibility: string | null
	postType: string | null
	hasVideo: boolean | null
	hasVideoSource: string | null
	declaredCta: {
		kind: string
		headline?: string
		subtitle?: string
	} | null
	resolvedDeclaration: ReturnType<typeof resolvePostCta> | null
	bodyAuthoredCtas: ReturnType<typeof scanBodyAuthoredCtas>
	productionBeforeMerge: AskModel
} & AskModel

function readArg(name: string) {
	const index = process.argv.indexOf(name)
	return index === -1 ? undefined : process.argv[index + 1]
}

function parseMode(): Mode {
	const mode = readArg('--mode') ?? 'on-demand'
	if (mode === 'build' || mode === 'on-demand' || mode === 'scheduled') {
		return mode
	}
	throw new Error(`Unknown --mode: ${mode}`)
}

function parseScope(): Scope {
	const scope = readArg('--scope') ?? 'all'
	if (scope === 'all' || scope === 'top-organic') return scope
	throw new Error(`Unknown --scope: ${scope}`)
}

function fieldString(
	fields: ResourceRecord['fields'] | undefined,
	key: string,
) {
	const value = fields?.[key]
	return typeof value === 'string' ? value : null
}

function sanitizeDeclaredCta(fields: ResourceRecord['fields'] | undefined) {
	const value = fields?.cta
	if (typeof value === 'string') return { kind: value }
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null

	const declaration = value as Record<string, unknown>
	const kind =
		typeof declaration.kind === 'string' ? declaration.kind : '(missing-kind)'
	const headline =
		typeof declaration.headline === 'string'
			? declaration.headline
			: undefined
	const subtitle =
		typeof declaration.subtitle === 'string'
			? declaration.subtitle
			: undefined

	return { kind, headline, subtitle }
}

function hasFieldDeclaration(fields: ResourceRecord['fields']) {
	return fields?.cta !== undefined && fields.cta !== null && fields.cta !== ''
}

function toPostRow(
	resource: ResourceRecord,
	options: { path?: string; clicks?: number | null } = {},
): ReportRow {
	const fields = resource.fields
	const slug = fieldString(fields, 'slug') ?? resource.id
	const postType = fieldString(fields, 'postType') ?? 'article'
	const hasVideo = Boolean(
		resource.resources?.some(({ resource: child }) => {
			return child.type === 'videoResource'
		}),
	)
	const bodyAuthoredCtas = scanBodyAuthoredCtas(
		typeof fields?.body === 'string' ? fields.body : '',
	)
	const resolvedDeclaration = resolvePostCta({
		postType,
		cta: fields?.cta,
	})
	const organicCta = organicOpportunityCtaBySlug[slug]
	const { merged, productionBeforeMerge } = buildPostAskInventories({
		bodyAuthoredCtas,
		hasVideo,
		organicCtaKind: organicCta,
		resolvedCta: resolvedDeclaration,
	})

	const flags: string[] = []
	if (merged.totalAnonymousReaderEmailAsks > 1) {
		flags.push('multiple-anonymous-email-asks')
	}
	if (options.clicks && merged.totalAnonymousReaderEmailAsks === 0) {
		flags.push('zero-email-asks-on-organic-page')
	}
	if (hasFieldDeclaration(fields) && bodyAuthoredCtas.length > 0) {
		flags.push('declared-and-body-authored-cta')
	}
	if (resolvedDeclaration.warning) {
		flags.push('unknown-declared-cta')
	}

	const productionFlags: string[] = []
	if (productionBeforeMerge.totalAnonymousReaderEmailAsks > 1) {
		productionFlags.push('multiple-anonymous-email-asks')
	}
	if (
		options.clicks &&
		productionBeforeMerge.totalAnonymousReaderEmailAsks === 0
	) {
		productionFlags.push('zero-email-asks-on-organic-page')
	}

	return {
		path: options.path ?? `/${slug}`,
		clicks: options.clicks ?? null,
		resourceId: resource.id,
		resourceType: resource.type,
		slug,
		title: fieldString(fields, 'title'),
		state: fieldString(fields, 'state'),
		visibility: fieldString(fields, 'visibility'),
		postType,
		hasVideo,
		hasVideoSource:
			'AI_ContentResourceResource child relation where child type=videoResource',
		declaredCta: sanitizeDeclaredCta(fields),
		resolvedDeclaration,
		bodyAuthoredCtas,
		...merged,
		humanReviewFlags: flags,
		productionBeforeMerge: {
			...productionBeforeMerge,
			humanReviewFlags: productionFlags,
		},
	}
}

function toListRow(
	resource: ResourceRecord,
	options: { path?: string; clicks?: number | null } = {},
): ReportRow {
	const fields = resource.fields
	const slug = fieldString(fields, 'slug') ?? resource.id
	const isDeadOrganicMapEntry = Boolean(organicOpportunityCtaBySlug[slug])
	const flags = []
	const currentTemplateCtas: TemplateCta[] = isDeadOrganicMapEntry
		? [
				{
					component: 'OrganicOpportunityCta',
					source: `organicOpportunityCtaBySlug:${organicOpportunityCtaBySlug[slug]}`,
					capturesEmailOnPage: false,
					rendersForCurrentRoute: false,
				},
			]
		: []

	if (options.clicks) flags.push('zero-email-asks-on-organic-page')
	if (isDeadOrganicMapEntry) flags.push('dead-organic-map-entry')

	return {
		path: options.path ?? `/${slug}`,
		clicks: options.clicks ?? null,
		resourceId: resource.id,
		resourceType: resource.type,
		slug,
		title: fieldString(fields, 'title'),
		state: fieldString(fields, 'state'),
		visibility: fieldString(fields, 'visibility'),
		postType: null,
		hasVideo: null,
		hasVideoSource: null,
		declaredCta: sanitizeDeclaredCta(fields),
		resolvedDeclaration: null,
		bodyAuthoredCtas: scanBodyAuthoredCtas(
			typeof fields?.body === 'string' ? fields.body : '',
		),
		currentTemplateCtas,
		anonymousReaderEmailAsks: [],
		totalAnonymousReaderEmailAsks: 0,
		subscriberConditionalAsks: [],
		humanReviewFlags: flags,
		productionBeforeMerge: {
			currentTemplateCtas,
			anonymousReaderEmailAsks: [],
			totalAnonymousReaderEmailAsks: 0,
			subscriberConditionalAsks: [],
			humanReviewFlags: flags,
		},
	}
}

function staticRow(target: TopOrganicTarget): ReportRow {
	const details = {
		home: {
			resourceType: 'static-home-route',
			slug: '',
			component: 'NewsletterSection + SlimNewsletterForm',
			count: 1,
		},
		'skills-index': {
			resourceType: 'static-skills-index-route',
			slug: 'skills',
			component: 'SkillsCourseCta',
			count: 0,
		},
		'posts-index': {
			resourceType: 'static-posts-index-route',
			slug: 'posts',
			component: null,
			count: 0,
		},
	}[target.route as 'home' | 'skills-index' | 'posts-index']

	const asks: EmailAsk[] =
		details.count === 1 && details.component
			? [{ component: details.component, source: 'template' }]
			: []
	const templateCtas: TemplateCta[] = details.component
		? [
				{
					component: details.component,
					source: 'static route source',
					capturesEmailOnPage: details.count === 1,
					rendersForCurrentRoute: true,
				},
			]
		: []
	const humanReviewFlags =
		asks.length === 0 ? ['zero-email-asks-on-organic-page'] : []

	return {
		path: target.path,
		clicks: target.clicks,
		resourceId: null,
		resourceType: details.resourceType,
		slug: details.slug,
		title: null,
		state: null,
		visibility: 'public',
		postType: null,
		hasVideo: null,
		hasVideoSource: null,
		declaredCta: null,
		resolvedDeclaration: null,
		bodyAuthoredCtas: [],
		currentTemplateCtas: templateCtas,
		anonymousReaderEmailAsks: asks,
		totalAnonymousReaderEmailAsks: asks.length,
		subscriberConditionalAsks: [],
		humanReviewFlags,
		productionBeforeMerge: {
			currentTemplateCtas: templateCtas,
			anonymousReaderEmailAsks: asks,
			totalAnonymousReaderEmailAsks: asks.length,
			subscriberConditionalAsks: [],
			humanReviewFlags,
		},
	}
}

function cohortRow(
	target: TopOrganicTarget,
	resource: ResourceRecord | undefined,
): ReportRow {
	const fields = resource?.fields
	const currentTemplateCtas: TemplateCta[] = [
		{
			component: 'CohortPricingWidgetContainer',
			source: 'cohort route, paid enrollment or waitlist variant',
			capturesEmailOnPage: true,
			rendersForCurrentRoute: true,
		},
	]
	const anonymousReaderEmailAsks: EmailAsk[] = [
		{
			component: 'CohortPricingWidgetContainer',
			source: 'template',
		},
	]
	const subscriberConditionalAsks = [
		{
			component: 'CohortPricingWidgetContainer',
			reason: 'variant depends on purchase and enrollment state',
		},
	]
	const humanReviewFlags = resource ? [] : ['missing-production-resource']

	return {
		path: target.path,
		clicks: target.clicks,
		resourceId: resource?.id ?? null,
		resourceType: resource?.type ?? 'cohort',
		slug:
			fieldString(fields, 'slug') ??
			target.resourceSlug ??
			target.path.split('/').at(-1) ??
			'',
		title: fieldString(fields, 'title'),
		state: fieldString(fields, 'state'),
		visibility: fieldString(fields, 'visibility'),
		postType: null,
		hasVideo: null,
		hasVideoSource: null,
		declaredCta: sanitizeDeclaredCta(fields),
		resolvedDeclaration: null,
		bodyAuthoredCtas: scanBodyAuthoredCtas(
			typeof fields?.body === 'string' ? fields.body : '',
		),
		currentTemplateCtas,
		anonymousReaderEmailAsks,
		totalAnonymousReaderEmailAsks: 1,
		subscriberConditionalAsks,
		humanReviewFlags,
		productionBeforeMerge: {
			currentTemplateCtas,
			anonymousReaderEmailAsks,
			totalAnonymousReaderEmailAsks: 1,
			subscriberConditionalAsks,
			humanReviewFlags,
		},
	}
}

function missingResourceRow(target: TopOrganicTarget): ReportRow {
	const slug =
		target.resourceSlug ?? target.path.replace(/^\/+/, '').replace(/\/+$/, '')
	return {
		path: target.path,
		clicks: target.clicks,
		resourceId: null,
		resourceType: 'missing',
		slug,
		title: null,
		state: null,
		visibility: null,
		postType: null,
		hasVideo: null,
		hasVideoSource: null,
		declaredCta: null,
		resolvedDeclaration: null,
		bodyAuthoredCtas: [],
		currentTemplateCtas: [],
		anonymousReaderEmailAsks: [],
		totalAnonymousReaderEmailAsks: 0,
		subscriberConditionalAsks: [],
		humanReviewFlags: ['missing-production-resource'],
		productionBeforeMerge: {
			currentTemplateCtas: [],
			anonymousReaderEmailAsks: [],
			totalAnonymousReaderEmailAsks: 0,
			subscriberConditionalAsks: [],
			humanReviewFlags: ['missing-production-resource'],
		},
	}
}

function verifyKnownDefects(rows: ReportRow[]) {
	const bySlug = new Map(rows.map((row) => [row.slug, row]))
	const ralph = bySlug.get('getting-started-with-ralph')
	const videoPages = ZERO_ASK_VIDEO_DEFECT_SLUGS.map((slug) => bySlug.get(slug))
	const bodyCtas = EXPECTED_BODY_CTA_DEFECTS.map((expected) => {
		const row = bySlug.get(expected.slug)
		const found = row?.bodyAuthoredCtas.some(
			(cta) =>
				cta.component === expected.component && cta.line === expected.line,
		)
		return { ...expected, found: Boolean(found) }
	})
	const roadmap = bySlug.get('ai-engineer-roadmap')

	const checks = {
		gettingStartedWithRalphHasTwoAnonymousEmailAsks:
			ralph?.productionBeforeMerge.totalAnonymousReaderEmailAsks === 2,
		sixKnownVideoPagesHaveZeroAnonymousEmailAsks:
			videoPages.length === 6 &&
			videoPages.every(
				(row) =>
					row?.hasVideo &&
					row.productionBeforeMerge.totalAnonymousReaderEmailAsks === 0,
			),
		threeBodyAuthoredSkillsNewsletterCtasHaveExpectedLines: bodyCtas.every(
			(result) => result.found,
		),
		aiEngineerRoadmapMapEntryIsDead:
			roadmap?.resourceType === 'list' &&
			roadmap.humanReviewFlags.includes('dead-organic-map-entry'),
	}

	return {
		checks,
		bodyCtas,
		allPassed: Object.values(checks).every(Boolean),
	}
}

function verifyMergedDeclarationModel(rows: ReportRow[], scope: Scope) {
	const publishedPublicSkillPosts = rows.filter(
		(row) =>
			row.resourceType === 'post' &&
			row.postType === 'skill' &&
			row.state === 'published' &&
			row.visibility === 'public',
	)
	const skillPostsWithoutVideo = publishedPublicSkillPosts.filter(
		(row) => row.hasVideo === false,
	)
	const skillPostsWithVideo = publishedPublicSkillPosts.filter(
		(row) => row.hasVideo === true,
	)
	const pagesRegressedToZero = rows
		.filter(
			(row) =>
				row.resourceType === 'post' &&
				row.productionBeforeMerge.totalAnonymousReaderEmailAsks > 0 &&
				row.totalAnonymousReaderEmailAsks === 0,
		)
		.map((row) => row.slug)

	const counts = {
		publishedPublicSkillPosts: publishedPublicSkillPosts.length,
		skillPostsWithoutVideo: skillPostsWithoutVideo.length,
		skillPostsWithVideo: skillPostsWithVideo.length,
		pagesRegressedToZero: pagesRegressedToZero.length,
	}

	if (scope !== 'all') {
		return {
			applicable: false,
			reason: 'Run with --scope all to verify every published public skill post.',
			counts,
			pagesRegressedToZero,
			checks: {},
			allPassed: true,
		}
	}

	const checks = {
		all23PublishedPublicSkillPostsHaveOneAnonymousEmailAsk:
			publishedPublicSkillPosts.length === 23 &&
			publishedPublicSkillPosts.every(
				(row) => row.totalAnonymousReaderEmailAsks === 1,
			),
		twentySkillPostsWithoutVideoSwapPrimaryForCourse:
			skillPostsWithoutVideo.length === 20 &&
			skillPostsWithoutVideo.every(
				(row) =>
					row.productionBeforeMerge.currentTemplateCtas.some(
						(cta) => cta.component === 'PrimaryNewsletterCta',
					) &&
					!row.currentTemplateCtas.some(
						(cta) => cta.component === 'PrimaryNewsletterCta',
					) &&
					row.currentTemplateCtas.some(
						(cta) => cta.component === 'SkillsCourseCta',
					) &&
					row.totalAnonymousReaderEmailAsks === 1,
			),
		threeSkillPostsWithVideoGoFromZeroToOne:
			skillPostsWithVideo.length === 3 &&
			skillPostsWithVideo.every(
				(row) =>
					row.productionBeforeMerge.totalAnonymousReaderEmailAsks === 0 &&
					row.totalAnonymousReaderEmailAsks === 1 &&
					row.currentTemplateCtas.some(
						(cta) => cta.component === 'SkillsCourseCta',
					),
			),
		noPageRegressesFromOneOrMoreEmailAsksToZero:
			pagesRegressedToZero.length === 0,
	}

	return {
		applicable: true,
		counts,
		pagesRegressedToZero,
		checks,
		allPassed: Object.values(checks).every(Boolean),
	}
}

async function loadPublishedResources() {
	const databaseUrl = process.env.DATABASE_URL
	if (!databaseUrl) throw new Error('DATABASE_URL is required')

	const pool = mysql.createPool({
		uri: databaseUrl,
		connectionLimit: 2,
		maxIdle: 2,
		enableKeepAlive: true,
	})
	const reportDb = drizzle(pool, { schema, mode: 'planetscale' })
	const resources = await reportDb.query.contentResource
		.findMany({
			columns: {
				id: true,
				type: true,
				fields: true,
				updatedAt: true,
			},
			where: and(
				inArray(contentResource.type, ['post', 'list', 'cohort']),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.state')) = 'published'`,
			),
			with: {
				resources: {
					columns: {
						resourceId: true,
					},
					with: {
						resource: {
							columns: {
								id: true,
								type: true,
							},
						},
					},
				},
			},
		})
		.finally(() => pool.end())

	return resources as ResourceRecord[]
}

function buildTopOrganicRows(resources: ResourceRecord[]) {
	const bySlug = new Map(
		resources.map((resource) => [fieldString(resource.fields, 'slug'), resource]),
	)

	return TOP_ORGANIC_TARGETS.map((target): ReportRow => {
		if (
			target.route === 'home' ||
			target.route === 'skills-index' ||
			target.route === 'posts-index'
		) {
			return staticRow(target)
		}

		const slug =
			target.resourceSlug ??
			target.path.replace(/^\/+/, '').replace(/\/+$/, '')
		const resource = bySlug.get(slug)

		if (target.route === 'cohort') return cohortRow(target, resource)
		if (!resource) return missingResourceRow(target)
		if (resource.type === 'list') {
			return toListRow(resource, { path: target.path, clicks: target.clicks })
		}
		return toPostRow(resource, { path: target.path, clicks: target.clicks })
	})
}

function buildAllRows(resources: ResourceRecord[]) {
	const postRows = resources
		.filter((resource) => resource.type === 'post')
		.map((resource) => toPostRow(resource))
	const mappedLists = resources
		.filter((resource) => {
			const slug = fieldString(resource.fields, 'slug')
			return resource.type === 'list' && slug && organicOpportunityCtaBySlug[slug]
		})
		.map((resource) => toListRow(resource))

	return [...postRows, ...mappedLists].sort((left, right) =>
		left.slug.localeCompare(right.slug),
	)
}

function printSummary(report: ReturnType<typeof makeReport>) {
	console.log(
		`CTA report: ${report.summary.rowCount} rows, ${report.summary.flaggedRowCount} flagged, ${report.summary.anonymousEmailAskCount} merged-model anonymous email asks (${report.summary.productionBeforeMergeAnonymousEmailAskCount} before merge).`,
	)

	for (const [name, passed] of Object.entries(
		report.knownDefectVerification.checks,
	)) {
		console.log(`${passed ? 'PASS' : 'FAIL'} production-before-merge:${name}`)
	}

	if (report.mergedDeclarationVerification.applicable) {
		for (const [name, passed] of Object.entries(
			report.mergedDeclarationVerification.checks,
		)) {
			console.log(`${passed ? 'PASS' : 'FAIL'} merged-declaration:${name}`)
		}
	}

	if (process.env.GITHUB_ACTIONS === 'true' && report.mode === 'scheduled') {
		for (const row of report.rows.filter(
			(candidate) => candidate.humanReviewFlags.length > 0,
		)) {
			console.log(
				`::warning title=CTA report ${row.path}::${row.humanReviewFlags.join(', ')}`,
			)
		}
	}
}

function makeReport(mode: Mode, scope: Scope, rows: ReportRow[]) {
	const knownDefectVerification = verifyKnownDefects(rows)
	const mergedDeclarationVerification = verifyMergedDeclarationModel(rows, scope)
	const flaggedRows = rows.filter((row) => row.humanReviewFlags.length > 0)
	const verified =
		knownDefectVerification.allPassed &&
		mergedDeclarationVerification.allPassed

	return {
		schemaVersion: 2,
		generatedAt: new Date().toISOString(),
		mode,
		scope,
		status: verified ? 'verified' : 'failed-verification',
		source: {
			content: 'AI_ContentResource.fields',
			video:
				'AI_ContentResourceResource child relation where child type=videoResource',
			organicMap:
				'apps/ai-hero/src/app/(content)/_components/organic-opportunity-cta.tsx',
			readOnly: true,
		},
		implementation: {
			declarationResolver: '@/lib/post-cta resolvePostCta',
			mergedRouteModel: [
				'post body',
				'SkillsCourseCta when resolvePostCta returns course',
				'OrganicOpportunityCta when the slug is mapped',
				'PrimaryNewsletterCta only when !hasVideo and resolved CTA is not course',
			],
			productionBeforeMerge:
				'each row preserves the production route before CTA placement for historical acceptance checks',
			buildPolicy: 'report flagged rows; do not fail a build for content flags',
		},
		subscriberStateLimit:
			'Counts describe the anonymous reader. Runtime subscriber variants are listed separately.',
		summary: {
			rowCount: rows.length,
			flaggedRowCount: flaggedRows.length,
			anonymousEmailAskCount: rows.reduce(
				(total, row) => total + row.totalAnonymousReaderEmailAsks,
				0,
			),
			productionBeforeMergeAnonymousEmailAskCount: rows.reduce(
				(total, row) =>
					total +
					row.productionBeforeMerge.totalAnonymousReaderEmailAsks,
				0,
			),
			flags: Object.fromEntries(
				[
					...new Set(
						flaggedRows.flatMap((row) => row.humanReviewFlags),
					),
				].map((flag) => [
					flag,
					flaggedRows.filter((row) => row.humanReviewFlags.includes(flag))
						.length,
				]),
			),
		},
		knownDefectVerification,
		mergedDeclarationVerification,
		rows,
	}
}

async function main() {
	const mode = parseMode()
	const scope = parseScope()
	const output = readArg('--output')
	const resources = await loadPublishedResources()
	const rows =
		scope === 'top-organic'
			? buildTopOrganicRows(resources)
			: buildAllRows(resources)
	const report = makeReport(mode, scope, rows)
	const serialized = `${JSON.stringify(report, null, 2)}\n`

	if (output) {
		const outputPath = resolve(output)
		await mkdir(dirname(outputPath), { recursive: true })
		await writeFile(outputPath, serialized, 'utf8')
		console.log(`Wrote ${outputPath}`)
	}

	printSummary(report)

	if (report.status !== 'verified' && mode !== 'build') {
		process.exitCode = 1
	}
}

main().catch((error: unknown) => {
	const mode = (() => {
		try {
			return parseMode()
		} catch {
			return 'on-demand'
		}
	})()
	const errorType = error instanceof Error ? error.name : 'UnknownError'
	console.error(`CTA report failed (${errorType}). No production data was changed.`)

	if (mode !== 'build') process.exitCode = 1
})
