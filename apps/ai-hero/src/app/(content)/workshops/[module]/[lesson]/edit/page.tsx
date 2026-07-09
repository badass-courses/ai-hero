import * as React from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { getLesson, getVideoResourceForLesson } from '@/lib/lessons-query'
import { getTags } from '@/lib/tags-query'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import { EditLessonClient } from './edit-lesson-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

const firstParam = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value

export async function generateMetadata(
	props: {
		params: Promise<{ lesson: string }>
	},
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const lesson = await getLesson(params.lesson)

	if (!lesson) {
		return parent as Metadata
	}

	return {
		title: `✏️ ${lesson.fields?.title}`,
	}
}

/**
 * Workshop lesson edit page — cms editor (`createResourceEditor`) cut-over.
 * Same server behavior as before: fetch the lesson, guard `create Content`,
 * resolve the primary video resource (may be null), plus the tag vocabulary
 * the editor's tag combobox needs (server-fetched, immediate entity writes).
 */
export default async function LessonEditPage(props: {
	params: Promise<{ module: string; lesson: string }>
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
	const params = await props.params
	const searchParams = await props.searchParams
	const { ability } = await getServerAuthSession()
	const lesson = await getLesson(params.lesson)

	if (!lesson || !ability.can('create', 'Content')) {
		notFound()
	}

	// Only fetch video resource if user has permission to view content
	let videoResource = null
	try {
		videoResource = await getVideoResourceForLesson(params.lesson)
	} catch (error) {
		log.error('lessonEditPage.getVideoResource.error', {
			error,
			lessonId: params.lesson,
		})
	}

	const tags = await getTags()

	// Serialize Date instances (LessonSchema z.coerce.date fields) to ISO
	// strings before crossing the RSC boundary — the toIso pattern from the
	// post/workshop edit pages; the schema coerces them back on validation.
	const clientLesson = {
		...lesson,
		createdAt: toIso(lesson.createdAt),
		updatedAt: toIso(lesson.updatedAt),
		deletedAt: toIso(lesson.deletedAt),
	} as typeof lesson

	return (
		<LayoutClient withFooter={false}>
			<EditLessonClient
				key={lesson.fields.slug}
				lesson={clientLesson}
				videoResource={videoResource}
				tags={tags}
				moduleSlug={params.module}
				// Server-computed (client bindings can't read server env) — gates
				// the per-video analytics strip on Mux Data being configured.
				videoAnalyticsEnabled={Boolean(
					env.MUX_DATA_TOKEN_ID && env.MUX_DATA_TOKEN_SECRET,
				)}
				// Seed the editor's tab/panel from the URL server-side so SSR
				// renders the same tab the client will (no hydration mismatch).
				initialTab={firstParam(searchParams.tab)}
				initialPanel={firstParam(searchParams.panel)}
			/>
		</LayoutClient>
	)
}
