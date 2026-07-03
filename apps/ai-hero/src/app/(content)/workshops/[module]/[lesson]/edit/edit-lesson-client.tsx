'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CmsLessonSolutionsField } from '@/app/(content)/workshops/_components/cms-lesson-solutions-field'
import { LessonVideoResourceField } from '@/app/(content)/workshops/_components/lesson-video-resource-field'
import { createLessonBindings } from '@/lib/cms/lesson-bindings'
import { LessonSchema, type Lesson } from '@/lib/lessons'
import type { Tag } from '@/lib/tags'
import type { UseFormReturn } from 'react-hook-form'

import type { VideoResource } from '@coursebuilder/core/schemas/video-resource'
import { createResourceEditor, lessonManifest } from '@coursebuilder/ui/cms'
import type { EditorCtx, FieldSpec } from '@coursebuilder/ui/cms/manifest'

export type EditLessonClientProps = {
	lesson: Lesson
	videoResource: VideoResource | null
	/** Full tag vocabulary, server-fetched by the page (`getTags`). */
	tags: Tag[]
	/** URL `module` segment — lesson routes live under `/workshops/{module}/`. */
	moduleSlug: string
}

/**
 * Client wrapper for the cms workshop-lesson editor (mirrors `EditPostClient`).
 * The editor component is created once per mount — NOT per render, the legacy
 * `withResourceForm`-inside-render flaw — via useMemo; the page keys this
 * component by slug so a slug change remounts with fresh data.
 *
 * Call-site deltas on the shared `lessonManifest`:
 * - `videoSlot` fills the manifest's Video tab with the existing lesson video
 *   field (self-contained: attach/detach socket updates + its own updateLesson
 *   thumbnail persistence), panel variant.
 * - The lesson↔solution navigation is appended to the Content tab as a
 *   `{ kind: 'custom' }` field — it closes over tRPC + app routes, so it
 *   can't live in the shared manifest.
 */
export function EditLessonClient({
	lesson,
	videoResource,
	tags,
	moduleSlug,
}: EditLessonClientProps) {
	const router = useRouter()

	const LessonEditor = React.useMemo(() => {
		const solutionsField: FieldSpec = {
			kind: 'custom',
			render: () => (
				<CmsLessonSolutionsField
					lessonId={lesson.id}
					moduleSlug={moduleSlug}
					lessonSlug={lesson.fields.slug}
				/>
			),
		}

		return createResourceEditor({
			manifest: {
				...lessonManifest,
				schema: LessonSchema,
				tabs: lessonManifest.tabs.map((tab) =>
					tab.label === 'Content'
						? { ...tab, fields: [...tab.fields, solutionsField] }
						: tab,
				),
				videoSlot: (ctx: EditorCtx) => (
					<LessonVideoResourceField
						// Same runtime object; cast bridges the linked ui package's own
						// react-hook-form copy vs the app's (post editor precedent).
						form={ctx.form as unknown as UseFormReturn<any>}
						lesson={lesson}
						videoResource={videoResource}
						variant="panel"
					/>
				),
			},
			bindings: createLessonBindings({
				moduleSlug,
				availableTags: tags.map((tag) => ({
					id: tag.id,
					label: tag.fields.label,
				})),
				onSlugChange: (slug) =>
					router.push(`/workshops/${moduleSlug}/${slug}/edit`),
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<LessonEditor
			resource={lesson}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
