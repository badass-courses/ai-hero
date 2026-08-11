import type { Metadata, ResolvingMetadata } from 'next'
import { LessonPage } from '@/app/(content)/workshops/[module]/[lesson]/(view)/shared-page'
import { getCachedLesson } from '@/lib/lessons-query'
import { getCachedMinimalWorkshop } from '@/lib/workshops-query'
import { measureIfSlow } from '@/server/perf'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'

// Lesson bodies and playback IDs are paid data. Keep this route request-bound
// so the server ability check in shared-page runs before either loader.
export const dynamic = 'force-dynamic'

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const lesson = await getCachedLesson(params.lesson)

	if (!lesson) {
		return parent as Metadata
	}

	const workshop = await getCachedMinimalWorkshop(params.module)
	const lessonTitle = lesson.fields?.title
	const workshopTitle = workshop?.fields?.title

	return {
		title:
			lessonTitle && workshopTitle
				? `${lessonTitle} | ${workshopTitle}`
				: lessonTitle,
		description: lesson.fields?.description,
		alternates: {
			canonical: `/workshops/${params.module}/${params.lesson}`,
		},
		openGraph: {
			images: [getOGImageUrlForResource(lesson)],
		},
	}
}

type Props = {
	params: Promise<{ lesson: string; module: string }>
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function LessonPageWrapper(props: Props) {
	return measureIfSlow({
		event: 'perf.lesson.page-wrapper.slow',
		spanName: 'lesson.page-wrapper.render',
		thresholdMs: 150,
		operation: async () => {
			const searchParams = await props.searchParams
			const params = await props.params
			const lesson = await getCachedLesson(params.lesson)
			const workshop = await getCachedMinimalWorkshop(params.module)

			return (
				<LessonPage
					searchParams={searchParams}
					lesson={lesson}
					params={params}
					workshop={workshop}
				/>
			)
		},
	})
}
