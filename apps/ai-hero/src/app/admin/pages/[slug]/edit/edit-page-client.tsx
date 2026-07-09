'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createPageBindings } from '@/lib/cms/page-bindings'
import { PageSchema, type Page } from '@/lib/pages'

import { createResourceEditor, pageManifest } from '@coursebuilder/ui/cms'

export type EditPageClientProps = {
	page: Page
	/** Initial tab/panel URL slugs, read from `searchParams` on the server. */
	initialTab?: string
	initialPanel?: string
}

/**
 * Client wrapper for the cms page editor (mirrors `EditPostClient`). The
 * editor component is created once per mount — NOT per render, the legacy
 * `withResourceForm`-inside-render flaw — via useMemo; the page keys this
 * component by slug so a slug change remounts with fresh data.
 */
export function EditPageClient({
	page,
	initialTab,
	initialPanel,
}: EditPageClientProps) {
	const router = useRouter()

	const PageEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...pageManifest,
				schema: PageSchema,
				// Legacy defaultValues parity (edit-pages-form.tsx): coerce
				// description/slug to '' so inputs stay controlled. socialImage is
				// seeded from the PERSISTED url only (empty when none) — seeding
				// the derived OG url would make every save persist it (the update
				// binding writes any non-empty url), freezing a stale snapshot;
				// the site derives the OG image at render time instead.
				defaultValues: (resource) => {
					const loaded = resource as Page
					return {
						...loaded,
						fields: {
							...loaded.fields,
							description: loaded.fields?.description ?? '',
							slug: loaded.fields?.slug ?? '',
							socialImage: {
								type: 'imageUrl',
								url: loaded.fields?.socialImage?.url ?? '',
							},
						},
					}
				},
			},
			bindings: createPageBindings({
				resourceId: page.id,
				onSlugChange: (slug) => router.push(`/admin/pages/${slug}/edit`),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<PageEditor
			resource={page}
			// Server-seeded from searchParams so SSR matches the client tab.
			initialTab={initialTab}
			initialPanel={initialPanel}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
