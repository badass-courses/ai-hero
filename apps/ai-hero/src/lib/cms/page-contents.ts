'use server'

import { getPage } from '@/lib/pages-query'
import { getServerAuthSession } from '@/server/auth'

import type { ContentsItem } from '@coursebuilder/ui/cms/manifest'

/**
 * `bindings.contents.list` for the cms page editor — the page's attached
 * resources ("page as curated collection", the legacy `ListResourcesEdit`
 * surface) as flat `ContentsItem[]`. Loads via the REAL page loader
 * (`getPage`, the same nested `resources` query the legacy list editor
 * consumed) rather than a parallel query. Pages have no sections and no
 * tiers, so rows never carry `children` or `tier`.
 */
export async function listPageContents(
	pageId: string,
): Promise<ContentsItem[]> {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const page = await getPage(pageId)
	if (!page) {
		throw new Error(`Page ${pageId} not found`)
	}

	return [...(page.resources ?? [])]
		.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
		.map((row): ContentsItem => {
			const resource: any = row.resource ?? {}
			const fields = resource.fields ?? {}
			return {
				id: resource.id,
				type: resource.type ?? 'resource',
				title: fields.title ?? fields.slug ?? resource.id,
				slug: fields.slug ?? undefined,
				state: fields.state ?? undefined,
				visibility: fields.visibility ?? undefined,
				detail: fields.postType ?? undefined,
				position: row.position ?? 0,
			}
		})
}
