'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createCohortBindings } from '@/lib/cms/cohort-bindings'
import { CohortSchema, type Cohort } from '@/lib/cohort'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { cohortManifest, createResourceEditor } from '@coursebuilder/ui/cms'

export type EditCohortClientProps = {
	cohort: Cohort
	/** Initial tab/panel URL slugs, read from `searchParams` on the server. */
	initialTab?: string
	initialPanel?: string
}

/**
 * Normalization for the form's default values — ''/undefined fallbacks so
 * inputs stay controlled (ports the legacy `cohortFormConfig.defaultValues`,
 * which becomes unreferenced with this cutover). Dates arrive as ISO strings
 * (schema-validated); timezone keeps the legacy LA default.
 */
function cohortDefaultValues(resource: unknown) {
	const cohort = resource as Cohort
	return {
		...cohort,
		fields: {
			...cohort?.fields,
			title: cohort?.fields?.title ?? '',
			slug: cohort?.fields?.slug ?? '',
			description: cohort?.fields?.description ?? '',
			body: cohort?.fields?.body ?? '',
			postPurchaseBody: cohort?.fields?.postPurchaseBody ?? '',
			image: cohort?.fields?.image ?? '',
			timezone: cohort?.fields?.timezone || 'America/Los_Angeles',
			state: cohort?.fields?.state ?? 'draft',
			visibility: cohort?.fields?.visibility ?? 'public',
			startsAt: cohort?.fields?.startsAt
				? new Date(cohort.fields.startsAt).toISOString()
				: undefined,
			endsAt: cohort?.fields?.endsAt
				? new Date(cohort.fields.endsAt).toISOString()
				: undefined,
		},
	}
}

/**
 * Client wrapper for the cms cohort editor. The editor component is created
 * once per mount (NOT per render — a per-render `createResourceEditor` would
 * remount the whole form on every keystroke, the exact flaw of the legacy
 * `withResourceForm` wiring). Module scope isn't possible because the router
 * (slug-change redirect) is per-request; the page keys this component by
 * slug, so a slug change remounts with fresh data.
 */
export function EditCohortClient({
	cohort,
	initialTab,
	initialPanel,
}: EditCohortClientProps) {
	const router = useRouter()

	const CohortEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...cohortManifest,
				schema: CohortSchema,
				defaultValues: cohortDefaultValues,
			},
			bindings: createCohortBindings({
				onSlugChange: (slug) => router.push(`/cohorts/${slug}/edit`),
				// Contents tab per-row ⋯ Edit → the child workshop's edit route.
				onEditItem: (item) =>
					router.push(getResourcePath(item.type, item.slug ?? item.id, 'edit')),
				// Per-row external-link icon → the child workshop's public URL.
				getItemHref: (item) =>
					item.slug ? getResourcePath(item.type, item.slug, 'view') : undefined,
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<CohortEditor
			resource={cohort}
			// Server-seeded from searchParams so SSR matches the client tab.
			initialTab={initialTab}
			initialPanel={initialPanel}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
