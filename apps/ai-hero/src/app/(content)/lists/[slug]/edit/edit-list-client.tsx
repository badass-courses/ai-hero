'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createListBindings } from '@/lib/cms/list-bindings'
import { ListSchema, type List } from '@/lib/lists'
import type { Tag } from '@/lib/tags'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { createResourceEditor, listManifest } from '@coursebuilder/ui/cms'

export type EditListClientProps = {
	list: List
	/** Full tag vocabulary, server-fetched by the page (`getTags`). */
	tags: Tag[]
}

/**
 * Client wrapper for the cms list editor (mirrors `EditPostClient`). The
 * editor component is created once per mount — NOT per render, the legacy
 * `withResourceForm`-inside-render flaw — via useMemo; the page keys this
 * component by slug so a slug change remounts with fresh data.
 */
export function EditListClient({ list, tags }: EditListClientProps) {
	const router = useRouter()

	const ListEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...listManifest,
				schema: ListSchema,
			},
			bindings: createListBindings({
				availableTags: tags.map((tag) => ({
					id: tag.id,
					label: tag.fields.label,
				})),
				onSlugChange: (slug) => router.push(`/lists/${slug}/edit`),
				// Resources tab per-row ⋯ Edit → the child's edit route (the app's
				// canonical type→route map; posts resolve to /posts/{slug}/edit).
				onEditItem: (item) =>
					router.push(
						getResourcePath(item.type, item.slug ?? item.id, 'edit', {
							parentType: 'list',
							parentSlug: list.fields.slug,
						}),
					),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<ListEditor
			resource={list}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
