'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
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

import { VideoResourceField } from '../../../posts/_components/video-resource-field'
import { NewsletterKitField } from './_components/newsletter-kit-field'

export type EditSkillChangelogClientProps = {
	entry: SkillChangelog
	videoResource: VideoResource | null
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
				// slot fills it with the existing post video field (self-contained:
				// socket updates + attach picker), post precedent.
				videoSlot: (ctx: EditorCtx) => (
					<VideoResourceField
						// Same runtime object; cast bridges the linked ui package's own
						// react-hook-form copy vs the app's type identity.
						form={ctx.form as unknown as UseFormReturn<any>}
						post={entry as any}
						videoResource={videoResource}
						variant="panel"
						// Legacy parity (skill-changelog-form-fields.tsx): thumbnail-time
						// picks persist immediately via a full-field snapshot save through
						// updateSkillChangelog — without this, VideoResourceField would
						// fall back to its posts-only updatePost path.
						onVideoUpdate={async (
							_resourceId,
							_videoResourceId,
							additionalFields,
						) => {
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
											additionalFields.thumbnailTime ??
											fields.thumbnailTime ??
											null,
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
				onSlugChange: (slug) => router.push(`/skills/${slug}/edit`),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<SkillChangelogEditor
			resource={entry}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
