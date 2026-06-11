import { contentResource } from '@/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Client as TypesenseClient } from 'typesense'

import type { ContentResource } from '@coursebuilder/core/schemas'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { INDEXABLE_TYPES, type IndexableType } from './indexable-types'

export type Ga4PageRow = {
	path: string
	pageviews: number
	users?: number
	avgDuration?: number
}

export type PopularityScore = {
	id: string
	popularity_30d: number
}

export type PathIndex = {
	exact: Map<string, string>
	prefix: Array<{ prefix: string; resourceId: string }>
	resourceIds: string[]
}

export type IndexablePopularityResource = Pick<
	ContentResource,
	'id' | 'type'
> & {
	fields: { slug?: string | null } | null
}

const PREFIX_TYPES: ReadonlySet<string> = new Set(['tutorial', 'workshop'])

export function normalizePath(input: string): string {
	if (!input) return '/'
	let p = input
	const queryIdx = p.indexOf('?')
	if (queryIdx !== -1) p = p.slice(0, queryIdx)
	const hashIdx = p.indexOf('#')
	if (hashIdx !== -1) p = p.slice(0, hashIdx)
	p = p.toLowerCase()
	if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
	if (p.length === 0) return '/'
	return p
}

function isIndexableType(t: string | null | undefined): t is IndexableType {
	return (
		typeof t === 'string' && (INDEXABLE_TYPES as readonly string[]).includes(t)
	)
}

export function buildPathIndex(
	resources: ReadonlyArray<IndexablePopularityResource>,
): PathIndex {
	const exact = new Map<string, string>()
	const prefix: Array<{ prefix: string; resourceId: string }> = []
	const resourceIds = new Set<string>()

	for (const resource of resources) {
		if (!isIndexableType(resource.type)) continue
		const slug = resource.fields?.slug
		if (typeof slug !== 'string' || slug.length === 0) continue

		resourceIds.add(resource.id)
		const builtPath = normalizePath(
			getResourcePath(resource.type, slug, 'view'),
		)
		exact.set(builtPath, resource.id)

		if (PREFIX_TYPES.has(resource.type)) {
			prefix.push({ prefix: `${builtPath}/`, resourceId: resource.id })
		}
	}

	prefix.sort((a, b) => b.prefix.length - a.prefix.length)
	return { exact, prefix, resourceIds: Array.from(resourceIds) }
}

export function computePopularityScores(
	gaRows: ReadonlyArray<Ga4PageRow>,
	pathIndex: PathIndex,
): {
	scores: PopularityScore[]
	mapped: number
	unmappedPaths: string[]
} {
	const totals = new Map<string, number>()
	const unmapped: string[] = []
	let mapped = 0

	for (const row of gaRows) {
		const path = normalizePath(row.path)
		let resourceId = pathIndex.exact.get(path)

		if (!resourceId) {
			for (const entry of pathIndex.prefix) {
				if (path.startsWith(entry.prefix)) {
					resourceId = entry.resourceId
					break
				}
			}
		}

		if (!resourceId) {
			unmapped.push(row.path)
			continue
		}

		mapped += 1
		const pageviews = Number.isFinite(row.pageviews) ? row.pageviews : 0
		totals.set(resourceId, (totals.get(resourceId) ?? 0) + pageviews)
	}

	const scores: PopularityScore[] = []
	for (const id of pathIndex.resourceIds) {
		const total = totals.get(id) ?? 0
		scores.push({ id, popularity_30d: Math.max(0, Math.trunc(total)) })
	}

	return { scores, mapped, unmappedPaths: unmapped }
}

export async function fetchIndexablePopularityResources(
	db: typeof import('@/db').db,
): Promise<IndexablePopularityResource[]> {
	const rows = await db.query.contentResource.findMany({
		where: and(
			inArray(contentResource.type, INDEXABLE_TYPES as unknown as string[]),
			eq(sql`JSON_EXTRACT(${contentResource.fields}, '$.state')`, 'published'),
			eq(
				sql`JSON_EXTRACT(${contentResource.fields}, '$.visibility')`,
				'public',
			),
		),
		columns: {
			id: true,
			type: true,
			fields: true,
		},
	})

	return rows.map((row) => ({
		id: row.id,
		type: row.type,
		fields: row.fields
			? { slug: (row.fields as { slug?: string | null }).slug ?? null }
			: null,
	}))
}

export async function writePopularityScores(
	client: TypesenseClient,
	collection: string,
	scores: ReadonlyArray<PopularityScore>,
): Promise<{ written: number; failed: number }> {
	if (scores.length === 0) {
		return { written: 0, failed: 0 }
	}

	const results = (await client
		.collections(collection)
		.documents()
		.import(scores as PopularityScore[], { action: 'emplace' })) as
		| Array<{ success: boolean }>
		| string

	if (typeof results === 'string') {
		// JSONL string response — count newlines containing "success":true
		const lines = results.split('\n').filter((l) => l.length > 0)
		let written = 0
		for (const line of lines) {
			if (line.includes('"success":true')) written += 1
		}
		return { written, failed: lines.length - written }
	}

	let written = 0
	for (const r of results) {
		if (r.success) written += 1
	}
	return { written, failed: results.length - written }
}
