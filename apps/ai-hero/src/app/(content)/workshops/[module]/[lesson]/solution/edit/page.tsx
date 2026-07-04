import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { getLesson } from '@/lib/lessons-query'
import {
	getSolutionForLesson,
	getVideoResourceForSolution,
} from '@/lib/solutions-query'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import { guid } from '@coursebuilder/utils/guid'

import { EditSolutionClient } from './edit-solution-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

/**
 * Solution edit page — cms editor (`createResourceEditor`) cut-over.
 * Same server behavior as before: allows creating (solution null → first
 * save creates + attaches) or editing the lesson's solution; only fetches
 * the video resource when a solution exists.
 */
export default async function SolutionEditPage({
	params,
}: {
	params: Promise<{ module: string; lesson: string }>
}) {
	const { module, lesson } = await params
	const { ability } = await getServerAuthSession()

	if (!ability.can('create', 'Content')) {
		notFound()
	}

	// Get the lesson first to ensure it exists
	const lessonData = await getLesson(lesson)
	if (!lessonData) {
		notFound()
	}

	// Get the solution for this lesson if it exists
	const solution = await getSolutionForLesson(lessonData.id)

	// If solution doesn't exist, prepare a default slug for create-on-save
	const defaultSlug = solution
		? solution.fields.slug
		: `${lessonData.fields.slug}-solution~${guid()}`

	// Only fetch video resource if user has permission to view content
	let videoResource = null
	if (solution) {
		try {
			videoResource = await getVideoResourceForSolution(solution.id)
		} catch (error) {
			log.error('solutionEditPage.getVideoResource.error', {
				error,
				solutionId: solution.id,
			})
		}
	}

	// Serialize Date instances (SolutionSchema z.coerce.date fields) to ISO
	// strings before crossing the RSC boundary — the toIso pattern from the
	// post/workshop edit pages; the schema coerces them back on validation.
	const clientSolution = solution
		? ({
				...solution,
				createdAt: toIso(solution.createdAt),
				updatedAt: toIso(solution.updatedAt),
				deletedAt: toIso(solution.deletedAt),
			} as typeof solution)
		: null

	return (
		<LayoutClient withFooter={false}>
			<EditSolutionClient
				key={solution?.fields.slug || `new-solution-${lessonData.id}`}
				solution={clientSolution}
				lesson={{
					id: lessonData.id,
					slug: lessonData.fields.slug,
					title: lessonData.fields.title,
				}}
				moduleSlug={module}
				defaultSlug={defaultSlug}
				videoResource={videoResource}
				// Server-computed (client bindings can't read server env) — gates
				// the per-video analytics strip on Mux Data being configured.
				videoAnalyticsEnabled={Boolean(
					env.MUX_DATA_TOKEN_ID && env.MUX_DATA_TOKEN_SECRET,
				)}
			/>
		</LayoutClient>
	)
}
