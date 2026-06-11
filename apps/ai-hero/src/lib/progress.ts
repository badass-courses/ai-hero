'use server'

import { cookies } from 'next/headers'
import { courseBuilderAdapter, db } from '@/db'
import { resourceProgress } from '@/db/schema'
import { LESSON_COMPLETED_EVENT } from '@/inngest/events/lesson-completed'
import { inngest } from '@/inngest/inngest.server'
import { SubscriberSchema } from '@/schemas/subscriber'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { and, eq } from 'drizzle-orm'

import {
	resourceProgressSchema,
	type ModuleProgress,
} from '@coursebuilder/core/schemas'

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

async function setResourceProgressForUser({
	resourceId,
	completedAt,
}: {
	resourceId: string
	completedAt: Date | null
}) {
	let user = await getUser()
	if (!user) return null
	// we can safely delete any existing progress
	await db
		.delete(resourceProgress)
		.where(
			and(
				eq(resourceProgress.resourceId, resourceId),
				eq(resourceProgress.userId, user.id),
			),
		)

	// immediately return if it isn't complete, no need to write
	if (!completedAt) return null

	const now = new Date()
	const progress = {
		userId: user.id,
		resourceId: resourceId,
		completedAt,
		updatedAt: now,
	}
	await db.insert(resourceProgress).values(progress)

	await sendInngestProgressEvent({
		user: user,
		lessonId: resourceId,
	})

	return resourceProgressSchema.parse(progress)
}

async function getUser() {
	const { session } = await getServerAuthSession()
	let user = session?.user
	if (user) {
		return user
	}

	const subscriberCookie = (await cookies()).get('ck_subscriber')

	if (!subscriberCookie) {
		void log.debug('progress.subscriber.missing', {
			scope: 'get-user',
		})
		return null
	}

	const parseResult = SubscriberSchema.safeParse(
		JSON.parse(subscriberCookie.value),
	)

	if (!parseResult.success) {
		void log.error('progress.subscriber.parse.error', {
			scope: 'get-user',
			error: parseResult.error.message,
		})
		return null
	}

	const subscriber = parseResult.data
	if (!subscriber?.email_address) {
		void log.debug('progress.subscriber.missing', {
			scope: 'get-user',
		})
		return null
	}

	return await courseBuilderAdapter
		.findOrCreateUser(subscriber.email_address, subscriber.first_name)
		.then(({ user }) => {
			return user
		})
}

export async function addProgress({ resourceId }: { resourceId: string }) {
	try {
		return setProgressForResource({ resourceId, isCompleted: true })
	} catch (error) {
		let message = 'Unknown Error'
		if (error instanceof Error) message = error.message
		void log.error('progress.add.error', {
			resourceId,
			error: message,
		})
		return { error: message }
	}
}

export async function setProgressForResource({
	resourceId,
	isCompleted,
}: {
	resourceId: string
	isCompleted: boolean
}) {
	try {
		const progress = await setResourceProgressForUser({
			resourceId: resourceId,
			completedAt: isCompleted ? new Date() : null,
		})
		return resourceProgressSchema.nullable().parse(progress)
	} catch (error) {
		let message = 'Unknown Error'
		if (error instanceof Error) message = error.message
		void log.error('progress.set.error', {
			resourceId,
			isCompleted,
			error: message,
		})
		return null
	}
}

export async function sendInngestProgressEvent({
	user,
	lessonId,
	lessonSlug,
}: {
	user: any
	lessonId: string
	lessonSlug?: string
}) {
	// TODO: execute a function that will email after a debounce to encourage
	await inngest.send({
		name: LESSON_COMPLETED_EVENT,
		data: {
			lessonId: lessonId,
		},
		user,
	})
}

export async function getModuleProgressForUser(
	moduleIdOrSlug: string,
): Promise<ModuleProgress | null> {
	return measureIfSlow({
		event: 'perf.module-progress.fetch.slow',
		spanName: 'module-progress.fetch',
		thresholdMs: 100,
		data: { moduleIdOrSlug },
		operation: async () => {
			const { session } = await getServerAuthSession()
			if (session?.user) {
				const moduleProgress =
					await courseBuilderAdapter.getModuleProgressForUser(
						session.user.id,
						moduleIdOrSlug,
					)

				return moduleProgress
			}

			const subscriberCookie = (await cookies()).get('ck_subscriber')

			if (!subscriberCookie) {
				void log.debug('progress.subscriber.missing', {
					scope: 'get-module-progress',
					moduleIdOrSlug,
				})
				return {
					completedLessons: [],
					nextResource: null,
					percentCompleted: 0,
					completedLessonsCount: 0,
					totalLessonsCount: 0,
				}
			}

			const parsedSubscriber = SubscriberSchema.safeParse(
				JSON.parse(subscriberCookie.value),
			)

			if (!parsedSubscriber.success) {
				void log.error('progress.subscriber.parse.error', {
					scope: 'get-module-progress',
					moduleIdOrSlug,
					error: parsedSubscriber.error.message,
				})
				return {
					completedLessons: [],
					nextResource: null,
					percentCompleted: 0,
					completedLessonsCount: 0,
					totalLessonsCount: 0,
				}
			}

			const subscriber = parsedSubscriber.data

			if (!subscriber?.email_address) {
				void log.debug('progress.subscriber.missing', {
					scope: 'get-module-progress',
					moduleIdOrSlug,
				})
				return {
					completedLessons: [],
					nextResource: null,
					percentCompleted: 0,
					completedLessonsCount: 0,
					totalLessonsCount: 0,
				}
			}
			const moduleProgress =
				await courseBuilderAdapter.getModuleProgressForUser(
					subscriber.email_address,
					moduleIdOrSlug,
				)
			return moduleProgress
		},
	})
}
