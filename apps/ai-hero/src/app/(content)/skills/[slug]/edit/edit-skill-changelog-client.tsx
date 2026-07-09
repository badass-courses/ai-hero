'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CmsVideoField } from '@/components/cms/cms-video-field'
import { createSkillChangelogBindings } from '@/lib/cms/skill-changelog-bindings'
import {
	SkillChangelogSchema,
	type SkillChangelog,
} from '@/lib/skill-changelog'
import { updateSkillChangelog } from '@/lib/skill-changelog-mutations'
import type { UseFormReturn } from 'react-hook-form'

import type { VideoResource } from '@coursebuilder/core/schemas/video-resource'
import {
	createResourceEditor,
	skillChangelogManifest,
} from '@coursebuilder/ui/cms'
import type { EditorCtx, FieldSpec } from '@coursebuilder/ui/cms/manifest'

import { NewsletterKitField } from './_components/newsletter-kit-field'

export type EditSkillChangelogClientProps = {
	entry: SkillChangelog
	videoResource: VideoResource | null
	/**
	 * Mux Data configured? Server-computed by the page (the bindings factory
	 * runs client-side and can't read server env) — gates `videoAnalytics`.
	 */
	videoAnalyticsEnabled?: boolean
	/** Initial tab/panel URL slugs, read from `searchParams` on the server. */
	initialTab?: string
	initialPanel?: string
}

/**
 * Client wrapper for the cms skill-changelog editor (mirrors
 * `EditPostClient`). The editor component is created once per mount — NOT per
 * render, the legacy `withResourceForm`-inside-render flaw — via useMemo; the
 * page keys this component by slug so a slug change remounts with fresh data.
 */
export function EditSkillChangelogClient({
	entry,
	videoResource,
	videoAnalyticsEnabled,
	initialTab,
	initialPanel,
}: EditSkillChangelogClientProps) {
	const router = useRouter()

	const SkillChangelogEditor = React.useMemo(() => {
		// Kit broadcast button + status — appended to the manifest's Newsletter
		// tab here because it closes over app server actions (`custom` contract).
		const broadcastField: FieldSpec = {
			kind: 'custom',
			render: (ctx) => <NewsletterKitField ctx={ctx} />,
		}

		return createResourceEditor({
			manifest: {
				...skillChangelogManifest,
				schema: SkillChangelogSchema,
				tabs: skillChangelogManifest.tabs.map((tab) =>
					tab.label === 'Newsletter'
						? { ...tab, fields: [...tab.fields, broadcastField] }
						: tab,
				),
				// The manifest's `video: true` adds the LEFT-panel Video tab; this
				// slot fills it with the shared cms wrapper (kit VideoField slots),
				// post precedent.
				videoSlot: (ctx: EditorCtx) => (
					<CmsVideoField
						// Same runtime object; cast bridges the linked ui package's own
						// react-hook-form copy vs the app's type identity.
						form={ctx.form as unknown as UseFormReturn<any>}
						resource={entry}
						videoResource={videoResource}
						videoAnalyticsEnabled={videoAnalyticsEnabled}
						// Legacy parity (skill-changelog-form-fields.tsx): thumbnail-time
						// picks persist immediately via a full-field snapshot save through
						// updateSkillChangelog (SkillChangelogUpdateSchema is strict, so
						// the snapshot is built field by field).
						onThumbnailUpdate={async ({ thumbnailTime }) => {
							const fields = (
								ctx.form as unknown as UseFormReturn<SkillChangelog>
							).getValues('fields')
							await updateSkillChangelog(
								{
									id: entry.id,
									fields: {
										title: fields.title || entry.fields.title || '',
										slug: fields.slug || entry.fields.slug || '',
										body: fields.body ?? '',
										description: fields.description ?? '',
										state: fields.state || entry.fields.state || 'draft',
										visibility:
											fields.visibility ||
											entry.fields.visibility ||
											'unlisted',
										github: fields.github ?? '',
										thumbnailTime:
											thumbnailTime ?? fields.thumbnailTime ?? null,
										...(fields.coverImage?.url
											? { coverImage: fields.coverImage }
											: {}),
										newsletterSubject: fields.newsletterSubject ?? null,
										newsletterPreviewText: fields.newsletterPreviewText ?? null,
										newsletterCopy: fields.newsletterCopy ?? null,
									},
								},
								'save',
							)
						}}
					/>
				),
			},
			bindings: createSkillChangelogBindings({
				resourceId: entry.id,
				onSlugChange: (slug) => router.push(`/skills/${slug}/edit`),
				videoAnalyticsEnabled,
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<SkillChangelogEditor
			resource={entry}
			// Server-seeded from searchParams so SSR matches the client tab.
			initialTab={initialTab}
			initialPanel={initialPanel}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
