'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createEmailBindings, EmailEditorSchema } from '@/lib/cms/email-bindings'
import { type Email } from '@/lib/emails'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'

import { createResourceEditor, emailManifest } from '@coursebuilder/ui/cms'

export type EditEmailClientProps = {
	email: Email
	/** Initial tab/panel URL slugs, read from `searchParams` on the server. */
	initialTab?: string
	initialPanel?: string
}

/**
 * Client wrapper for the cms email editor (mirrors `EditPostClient`). The
 * editor component is created once per mount — NOT per render, the legacy
 * `withResourceForm`-inside-render flaw — via useMemo; the page keys this
 * component by slug so a slug change remounts with fresh data.
 *
 * Uses `EmailEditorSchema` (EmailSchema + empty-subject→null preprocess) so
 * clearing the new Subject field can't fail `min(2)` and block saves.
 */
export function EditEmailClient({
	email,
	initialTab,
	initialPanel,
}: EditEmailClientProps) {
	const router = useRouter()

	const EmailEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...emailManifest,
				schema: EmailEditorSchema,
				// Legacy-parity normalization: same ''/null coercions the old
				// useForm defaults applied, INCLUDING the derived OG socialImage
				// injection (the legacy form persisted it on every save).
				defaultValues: (resource) => {
					const value = resource as Email
					return {
						...value,
						fields: {
							...value.fields,
							body: value.fields?.body ?? '',
							subject: value.fields?.subject ?? '',
							description: value.fields?.description ?? '',
							socialImage: {
								type: 'imageUrl',
								url: getOGImageUrlForResource(value),
							},
							slug: value.fields?.slug ?? '',
						},
					}
				},
			},
			bindings: createEmailBindings({
				resourceId: email.id,
				onSlugChange: (slug) => router.push(`/admin/emails/${slug}/edit`),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<EmailEditor
			resource={email}
			// Server-seeded from searchParams so SSR matches the client tab.
			initialTab={initialTab}
			initialPanel={initialPanel}
			// Renders inside the admin layout (LayoutClient nav + sidebar grid);
			// subtract the nav like the other cms routes do.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
