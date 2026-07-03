'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { LessonVideoResourceField } from '@/app/(content)/workshops/_components/lesson-video-resource-field'
import { createSolutionBindings } from '@/lib/cms/solution-bindings'
import { SolutionSchema, type Solution } from '@/lib/solution'
import type { UseFormReturn } from 'react-hook-form'

import type { VideoResource } from '@coursebuilder/core/schemas/video-resource'
import { createResourceEditor, solutionManifest } from '@coursebuilder/ui/cms'
import type { EditorCtx } from '@coursebuilder/ui/cms/manifest'

export type EditSolutionClientProps = {
	/** null → CREATE mode: the first save creates + attaches the solution. */
	solution: Solution | null
	/** Parent lesson context (server-fetched) — join target + "Part of" strip. */
	lesson: { id: string; slug: string; title: string }
	moduleSlug: string
	/** Pre-seeded `{lessonSlug}-solution~{guid}` slug for CREATE mode. */
	defaultSlug: string
	videoResource: VideoResource | null
}

/**
 * Builds the CREATE-mode placeholder the legacy `EditSolutionForm` built in
 * its defaultValues: a valid-per-SolutionSchema empty solution whose `id: ''`
 * routes the first save through `createSolution` (create-on-save).
 */
function placeholderSolution(defaultSlug: string): Solution {
	return {
		id: '',
		type: 'solution',
		createdById: '',
		organizationId: null,
		createdByOrganizationMembershipId: null,
		createdAt: null,
		updatedAt: null,
		deletedAt: null,
		fields: {
			title: '',
			body: '',
			slug: defaultSlug,
			description: '',
			state: 'draft',
			visibility: 'unlisted',
			videoResourceId: null,
			thumbnailTime: 0,
			optional: false,
		},
		resources: [],
	} as Solution
}

/**
 * Client wrapper for the cms solution editor (mirrors `EditPostClient`). The
 * editor component is created once per mount via useMemo; the page keys this
 * component by the solution's slug (or a create-mode key), so creation and
 * external changes remount with fresh data.
 *
 * Navigation back to the lesson comes from `bindings.getParents` → the
 * "Part of" strip (replaces the legacy "Back to Lesson" button). After a
 * create-on-save, `router.refresh()` re-runs the RSC page, which now finds
 * the persisted solution and remounts the editor keyed by its slug — so a
 * second save updates instead of creating a duplicate.
 */
export function EditSolutionClient({
	solution,
	lesson,
	moduleSlug,
	defaultSlug,
	videoResource,
}: EditSolutionClientProps) {
	const router = useRouter()

	const resource = React.useMemo(
		() => solution ?? placeholderSolution(defaultSlug),
		[solution, defaultSlug],
	)

	const SolutionEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...solutionManifest,
				schema: SolutionSchema,
				// The manifest's `video: true` adds the left-panel Video tab; this
				// slot fills it with the existing lesson/solution video field
				// (self-contained: socket updates + its own updateSolution call).
				videoSlot: (ctx: EditorCtx) => (
					<LessonVideoResourceField
						// Same runtime object; cast bridges the linked ui package's own
						// react-hook-form copy vs the app's (post editor precedent).
						form={ctx.form as unknown as UseFormReturn<any>}
						lesson={resource}
						videoResource={videoResource}
						variant="panel"
					/>
				),
			},
			bindings: createSolutionBindings({
				moduleSlug,
				lesson,
				// Re-run the RSC page → it finds the created row → key change
				// remounts the editor in UPDATE mode.
				onCreated: () => router.refresh(),
			}),
		})
		// Stable per mount by design; the page's key handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<SolutionEditor
			resource={resource}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
