'use server'

import { db } from '@/db'
import {
	contentResourceProduct,
	contentResourceResource,
} from '@/db/schema'
import { getProductWithFullStructure } from '@/lib/products-query'
import { getCachedWorkshopNavigation } from '@/lib/workshops-query'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import {
	getNextWorkshopLesson,
	type CourseLessonDestination,
	type CourseResource,
} from './course-resume-navigation'

function navigationDestination(
	destination: CourseLessonDestination,
): CourseLessonDestination {
	return {
		lesson: {
			id: destination.lesson.id,
			type: destination.lesson.type,
			fields: destination.lesson.fields,
		},
		workshop: {
			id: destination.workshop.id,
			type: destination.workshop.type,
			fields: destination.workshop.fields,
		},
		href: destination.href,
	}
}

export async function getCrossWorkshopNextLesson({
	currentWorkshopId,
	currentResourceId,
}: {
	currentWorkshopId: string
	currentResourceId: string
}): Promise<CourseLessonDestination | null> {
	const workshopNavigation = await getCachedWorkshopNavigation(currentWorkshopId)
	const { nextResource } = getAdjacentWorkshopResources(
		workshopNavigation,
		currentResourceId,
	)

	if (nextResource) return null

	const parentRelations = await db
		.select({ resourceOfId: contentResourceResource.resourceOfId })
		.from(contentResourceResource)
		.where(
			and(
				eq(contentResourceResource.resourceId, currentWorkshopId),
				isNull(contentResourceResource.deletedAt),
			),
		)
	const productResourceIds = [
		currentWorkshopId,
		...parentRelations.map((relation) => relation.resourceOfId),
	]
	const productRelations = await db
		.select({ productId: contentResourceProduct.productId })
		.from(contentResourceProduct)
		.where(
			and(
				inArray(contentResourceProduct.resourceId, productResourceIds),
				isNull(contentResourceProduct.deletedAt),
			),
		)
	const productIds = [
		...new Set(productRelations.map((relation) => relation.productId)),
	]
	const products = await Promise.all(
		productIds.map((productId) => getProductWithFullStructure(productId)),
	)

	for (const product of products) {
		if (!product?.resources) continue

		const productResources = [...product.resources]
			.sort((left, right) => left.position - right.position)
			.map((relation) => relation.resource as CourseResource)
			.filter(Boolean)
		const destination = getNextWorkshopLesson(
			productResources,
			currentWorkshopId,
		)

		if (destination) return navigationDestination(destination)
	}

	return null
}
