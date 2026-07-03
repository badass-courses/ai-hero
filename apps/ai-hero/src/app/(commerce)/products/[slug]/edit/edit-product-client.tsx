'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
	createProductBindings,
	ProductEditorSchema,
} from '@/lib/cms/product-bindings'

import type { Product } from '@coursebuilder/core/schemas'
import {
	createResourceEditor,
	PRODUCT_ARCHIVE_DEFAULT_ACCESS_DURATION_DAYS,
	PRODUCT_ARCHIVE_DEFAULT_AVAILABLE_AFTER_DAYS,
	productManifest,
} from '@coursebuilder/ui/cms'
import type { EditorCtx, FieldTab } from '@coursebuilder/ui/cms/manifest'

export type EditProductClientProps = {
	product: Product
}

/**
 * Headless form effects the manifest can't express (no field-effects hook in
 * the kit) — rendered via a `custom` FieldSpec appended to every tab so one
 * instance is always mounted whichever tab is active. Renders nothing.
 *
 * 1. Bespoke type-select parity: switching to 'cohort-archive' seeds the
 *    day-field defaults (15/365) when empty; switching away clears both.
 * 2. Mirrors `name` → `fields.title` so the action bar / archive dialog show
 *    the product's name live (productSchema strips unknown `fields` keys on
 *    parse, so the mirror never persists).
 */
function ProductEditorEffects({ ctx }: { ctx: EditorCtx }) {
	const { form } = ctx
	const type = form.watch('type')
	const name = form.watch('name')

	React.useEffect(() => {
		if ((form.getValues('fields.title') ?? '') !== (name ?? '')) {
			form.setValue('fields.title', name ?? '', { shouldDirty: false })
		}
	}, [form, name])

	const previousType = React.useRef(type)
	React.useEffect(() => {
		if (previousType.current === type) return
		previousType.current = type
		if (type === 'cohort-archive') {
			if (!form.getValues('fields.availableAfterDays')) {
				form.setValue(
					'fields.availableAfterDays',
					PRODUCT_ARCHIVE_DEFAULT_AVAILABLE_AFTER_DAYS,
					{ shouldDirty: true },
				)
			}
			if (!form.getValues('fields.accessDurationDays')) {
				form.setValue(
					'fields.accessDurationDays',
					PRODUCT_ARCHIVE_DEFAULT_ACCESS_DURATION_DAYS,
					{ shouldDirty: true },
				)
			}
		} else {
			form.setValue('fields.availableAfterDays', null, { shouldDirty: true })
			form.setValue('fields.accessDurationDays', null, { shouldDirty: true })
		}
	}, [form, type])

	return null
}

/** Append the headless effects spec to each tab (exactly one tab renders at a time). */
const tabsWithEffects: FieldTab[] = productManifest.tabs.map((tab) => ({
	...tab,
	fields: [
		...tab.fields,
		{
			kind: 'custom' as const,
			render: (ctx: EditorCtx) => <ProductEditorEffects ctx={ctx} />,
		},
	],
}))

/**
 * Client wrapper for the cms product editor. The editor component is created
 * once per mount (NOT per render — a per-render `createResourceEditor` would
 * remount the whole form on every keystroke). Module scope isn't possible
 * because the router (slug-change redirect) is per-request; the page keys
 * this component by slug, so a slug change remounts with fresh data.
 */
export function EditProductClient({ product }: EditProductClientProps) {
	const router = useRouter()

	const ProductEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...productManifest,
				schema: ProductEditorSchema,
				tabs: tabsWithEffects,
			},
			bindings: createProductBindings({
				onSlugChange: (slug) => router.push(`/products/${slug}/edit`),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<ProductEditor
			resource={product}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
