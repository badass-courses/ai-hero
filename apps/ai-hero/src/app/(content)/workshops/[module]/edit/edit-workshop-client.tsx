'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createWorkshopBindings } from '@/lib/cms/workshop-bindings'
import { WorkshopSchema, type Workshop } from '@/lib/workshops'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { createResourceEditor, workshopManifest } from '@coursebuilder/ui/cms'

export type EditWorkshopClientProps = {
	workshop: Workshop
}

/**
 * Client wrapper for the cms workshop editor (mirrors `EditPostClient`). The
 * editor component is created once per mount — NOT per render, the legacy
 * `withResourceForm`-inside-render flaw — via useMemo; the page keys this
 * component by slug so a slug change remounts with fresh data.
 */
export function EditWorkshopClient({ workshop }: EditWorkshopClientProps) {
	const router = useRouter()

	const WorkshopEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...workshopManifest,
				schema: WorkshopSchema,
			},
			bindings: createWorkshopBindings({
				onSlugChange: (slug) => router.push(`/workshops/${slug}/edit`),
				// Contents tab per-row ⋯ Edit → the child's edit route (lessons
				// resolve under this workshop, posts to /posts/{slug}/edit).
				onEditItem: (item) =>
					router.push(
						getResourcePath(item.type, item.slug ?? item.id, 'edit', {
							parentType: 'workshop',
							parentSlug: workshop.fields.slug,
						}),
					),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<WorkshopEditor
			resource={workshop}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
