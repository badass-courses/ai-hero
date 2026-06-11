'use client'

import Link from 'next/link'
import { getAdjacentWorkshopResources } from '@/utils/get-adjacent-workshop-resources'
import { ArrowRight } from 'lucide-react'

import { Button } from '@coursebuilder/ui'

import { useWorkshopNavigation } from './workshop-navigation-provider'

export function NextLessonToolbarButton({
	lessonId,
	moduleSlug,
}: {
	lessonId: string
	moduleSlug: string
}) {
	const workshopNavigation = useWorkshopNavigation()
	const { nextResource } = getAdjacentWorkshopResources(
		workshopNavigation,
		lessonId,
	)

	if (!nextResource?.fields?.slug) return null

	return (
		<Button
			asChild
			variant="outline"
			className="hover:bg-muted/50 border-l-border h-10 rounded-none border-0 border-l bg-transparent sm:h-12"
		>
			<Link
				href={`/workshops/${moduleSlug}/${nextResource.fields.slug}`}
				prefetch
			>
				Next lesson
				<ArrowRight className="text-muted-foreground ml-2 h-4 w-4" />
			</Link>
		</Button>
	)
}
