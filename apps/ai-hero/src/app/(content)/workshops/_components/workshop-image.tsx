'use client'

import Image from 'next/image'
import Link from 'next/link'
import {
	getWorkshopResourceHref,
	getWorkshopStartHref,
} from '@/lib/course-resume-navigation'
import { PlayIcon } from '@heroicons/react/24/solid'

import { useModuleProgress } from '../../_components/module-progress-provider'
import { useWorkshopAbility } from './use-workshop-ability'
import { useWorkshopNavigation } from './workshop-navigation-provider'

export default function WorkshopImage({ imageUrl }: { imageUrl: string }) {
	const workshopNavigation = useWorkshopNavigation()
	const { moduleProgress } = useModuleProgress()
	const nextHref = getWorkshopResourceHref(
		workshopNavigation,
		moduleProgress?.nextResource,
	)
	const { canViewWorkshop: canView, status } = useWorkshopAbility()
	const url =
		(moduleProgress?.completedLessons?.length ?? 0) > 0 && nextHref
			? nextHref
			: getWorkshopStartHref(workshopNavigation)
	// Full-bleed: the image fills its header column edge-to-edge with square
	// corners — on desktop the column is stretched to the header's height and
	// the image covers it; on mobile the 16:9 box sets its own height.
	const containerClassName =
		'group relative block aspect-video w-full md:absolute md:inset-0 md:aspect-auto'
	const Comp = ({ children }: { children: React.ReactNode }) =>
		status === 'success' && canView && url ? (
			<Link className={containerClassName} href={url}>
				{children}
			</Link>
		) : (
			<div className={containerClassName}>{children}</div>
		)

	return (
		<Comp>
			<Image
				priority
				fill
				alt={workshopNavigation?.fields?.title || ''}
				src={imageUrl}
				className="object-cover"
				sizes="(max-width: 768px) 100vw, 33vw"
			/>
			{status === 'success' && canView && url && (
				<div className="bg-background/80 absolute bottom-5 right-5 flex items-center justify-center rounded-full p-2 backdrop-blur-md transition ease-out group-hover:scale-110">
					<PlayIcon className="relative h-5 w-5 translate-x-px" />
					<span className="sr-only">Start Learning</span>
				</div>
			)}
		</Comp>
	)
}
