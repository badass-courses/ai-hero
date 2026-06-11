import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { indexAiCodingDictionaryToTypesense } from '@/lib/ai-coding-dictionary-typesense'
import { INDEXABLE_TYPES } from '@/lib/indexable-types'
import { indexAllContentToTypeSense } from '@/lib/typesense-query'
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'

const SHOULD_DELETE_ALL_FIRST = false
const PAGE_SIZE = 50

async function fetchVideoResourceLinks(
	postIds: string[],
): Promise<Map<string, string>> {
	const map = new Map<string, string>()
	if (postIds.length === 0) return map

	const links = await db
		.select({
			resourceOfId: contentResourceResource.resourceOfId,
			resourceId: contentResourceResource.resourceId,
		})
		.from(contentResourceResource)
		.innerJoin(
			contentResource,
			eq(contentResourceResource.resourceId, contentResource.id),
		)
		.where(
			and(
				eq(contentResource.type, 'videoResource'),
				inArray(contentResourceResource.resourceOfId, postIds),
			),
		)

	for (const link of links) {
		if (!map.has(link.resourceOfId)) {
			map.set(link.resourceOfId, link.resourceId)
		}
	}
	return map
}

function patchVideoResourceIds<
	T extends { id: string; fields: Record<string, any> | null },
>(resources: T[], videoMap: Map<string, string>): T[] {
	return resources.map((r) => {
		const existing = (r.fields as any)?.videoResourceId
		if (existing) return r
		const videoId = videoMap.get(r.id)
		if (!videoId) return r
		return { ...r, fields: { ...r.fields, videoResourceId: videoId } }
	})
}

async function indexPage(page: any[], label: string) {
	if (page.length === 0) return
	const videoMap = await fetchVideoResourceLinks(page.map((r) => r.id))
	const patched = patchVideoResourceIds(page, videoMap)
	console.log(
		`${label}: indexing ${patched.length} resource${
			patched.length === 1 ? '' : 's'
		} (${videoMap.size} video link${videoMap.size === 1 ? '' : 's'})`,
	)
	await indexAllContentToTypeSense(patched as any, SHOULD_DELETE_ALL_FIRST)
}

async function indexDictionary() {
	const dictionaryResult = await indexAiCodingDictionaryToTypesense({
		deleteFirst: true,
	})
	console.log(
		`Indexed ${dictionaryResult.documentCount} AI Coding Dictionary documents`,
	)
}

async function main() {
	try {
		const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined
		const slugs = process.env.SLUGS
			? process.env.SLUGS.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined

		if (slugs && slugs.length > 0) {
			const resources = await db.query.contentResource.findMany({
				where: inArray(
					sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
					slugs,
				),
			})
			await indexPage(resources, `SLUGS=${slugs.join(',')}`)
			console.log(`Indexing completed (${resources.length} resource(s))`)
			return
		}

		const cap = limit && Number.isFinite(limit) ? limit : Infinity
		let processed = 0
		let cursor: Date | null = null
		let pageNum = 0

		while (processed < cap) {
			const remaining = cap - processed
			const pageSize = Math.min(PAGE_SIZE, remaining)

			const conditions = [inArray(contentResource.type, INDEXABLE_TYPES as any)]
			if (cursor) conditions.push(lt(contentResource.createdAt, cursor))

			const page = await db.query.contentResource.findMany({
				where: and(...conditions),
				orderBy: [desc(contentResource.createdAt)],
				limit: pageSize,
			})

			if (page.length === 0) break

			pageNum += 1
			await indexPage(page, `Page ${pageNum}`)

			processed += page.length
			const last = page[page.length - 1]
			cursor = last?.createdAt ?? null
			if (!cursor) break
		}

		await indexDictionary()

		console.log(
			`Indexing completed (${processed} resource${processed === 1 ? '' : 's'})`,
		)
	} catch (error) {
		console.error('Failed to index content:', error)
	}
	process.exit(0)
}

main()
