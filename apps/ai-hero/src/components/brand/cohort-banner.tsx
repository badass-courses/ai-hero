import Link from 'next/link'
import { CldImage } from '@/components/cld-image'
import type { Cohort } from '@/lib/cohort'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { ArrowRight } from 'lucide-react'

export function CohortBanner({ cohort }: { cohort: Cohort }) {
	const { fields } = cohort
	const { startsAt, endsAt, timezone } = fields
	const tz = timezone || 'America/Los_Angeles'
	const { dateString } = formatCohortDateRange(startsAt, endsAt, tz)

	return (
		<Link
			href={`/cohorts/${fields.slug}`}
			className="group relative flex w-full grid-cols-2 flex-col-reverse overflow-hidden border-y sm:grid"
			prefetch
		>
			<div className="flex flex-col justify-center gap-4 px-6 py-6 sm:px-16 sm:py-10">
				{dateString && (
					<p className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
						{dateString}
					</p>
				)}
				<h2 className="text-2xl font-bold leading-tight sm:text-3xl">
					{fields.title}
				</h2>
				{fields.description && (
					<p className="text-muted-foreground line-clamp-3 max-w-md text-balance text-base">
						{fields.description}
					</p>
				)}
				<span className="bg-primary text-primary-foreground mt-1 inline-flex w-fit items-center gap-2 rounded px-4 py-2 text-sm font-semibold transition group-hover:brightness-110">
					Get Your Ticket
					<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
				</span>
			</div>
			{fields.image && (
				<div className="aspect-480/270 relative h-full sm:aspect-auto">
					<CldImage
						src={fields.image}
						alt={fields.title}
						fill
						className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02]"
						sizes="(min-width: 640px) 50vw, 100vw"
					/>
				</div>
			)}
		</Link>
	)
}
