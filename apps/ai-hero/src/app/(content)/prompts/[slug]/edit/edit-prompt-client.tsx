'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createPromptBindings } from '@/lib/cms/prompt-bindings'
import { PromptSchema, type Prompt } from '@/lib/prompts'

import { createResourceEditor, promptManifest } from '@coursebuilder/ui/cms'

export type EditPromptClientProps = {
	prompt: Prompt
	/** Initial tab/panel URL slugs, read from `searchParams` on the server. */
	initialTab?: string
	initialPanel?: string
}

/**
 * Client wrapper for the cms prompt editor (mirrors `EditPostClient`). The
 * editor component is created once per mount — NOT per render, the legacy
 * `withResourceForm`-inside-render flaw — via useMemo; the page keys this
 * component by slug so a slug change remounts with fresh data.
 */
export function EditPromptClient({
	prompt,
	initialTab,
	initialPanel,
}: EditPromptClientProps) {
	const router = useRouter()

	const PromptEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...promptManifest,
				schema: PromptSchema,
				// Legacy-parity normalization (''/null fallbacks) so inputs stay
				// controlled — same coercions the old useForm defaults applied,
				// plus body for the kit's body editor.
				defaultValues: (resource) => {
					const value = resource as Prompt
					return {
						...value,
						fields: {
							...value.fields,
							body: value.fields?.body ?? '',
							description: value.fields?.description ?? '',
							slug: value.fields?.slug ?? '',
						},
					}
				},
			},
			bindings: createPromptBindings({
				onSlugChange: (slug) => router.push(`/prompts/${slug}/edit`),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<PromptEditor
			resource={prompt}
			// Server-seeded from searchParams so SSR matches the client tab.
			initialTab={initialTab}
			initialPanel={initialPanel}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
