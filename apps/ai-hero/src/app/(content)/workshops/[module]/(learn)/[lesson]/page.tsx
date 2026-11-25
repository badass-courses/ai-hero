import type { Metadata, ResolvingMetadata } from 'next'
import { metaDescription } from '@/lib/meta-description'
import {
	LessonPage,
	type LessonTimingPart,
} from '@/app/(content)/workshops/[module]/(learn)/[lesson]/shared-page'
import { LessonAbilitySeed } from '@/app/(content)/workshops/_components/lesson-ability-seed'
import { getCachedLesson } from '@/lib/lesson-read-query'
import { getCachedMinimalWorkshop } from '@/lib/workshops-query'
import { getServerAuthSession } from '@/server/auth'
import { measureIfSlow, sampleTimings } from '@/server/perf'
import { getCurrentAbilityRules } from '@/utils/get-current-ability-rules'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'

// Lesson bodies and playback IDs are paid data. Keep this route request-bound
// so the server ability check in shared-page runs before either loader.
// The rules below are user-specific: a cached or shared shell could serve
// one user's purchases to everyone.
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
		description: metaDescription(lesson.fields?.description),
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
	const timings = sampleTimings<LessonTimingPart>(
		'perf.lesson.timings',
		Number(process.env.LESSON_TIMING_SAMPLE_RATE?.trim() || NaN),
	)
	return measureIfSlow({
		event: 'perf.lesson.page-wrapper.slow',
		spanName: 'lesson.page-wrapper.render',
		thresholdMs: 150,
		operation: () =>
			timings.measure('wrapperTotal', async () => {
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
						abilitySeed={
							<LessonPageAbilitySeed
								moduleId={params.module}
								lessonId={params.lesson}
							/>
						}
						timings={timings}
					/>
				)
			}),
	})
}

async function LessonPageAbilitySeed(input: {
	moduleId: string
	lessonId: string
}) {
	const { session } = await getServerAuthSession()
	const id = session?.user?.id
	// LessonPage renders this slot only after its access check. That check
	// already resolved these same rules in React's request cache.
	const viewer = id ? { id, rules: await getCurrentAbilityRules(input) } : null
	return <LessonAbilitySeed {...input} viewer={viewer} />
}
