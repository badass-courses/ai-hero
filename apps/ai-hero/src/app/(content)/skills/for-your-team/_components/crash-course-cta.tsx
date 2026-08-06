import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { getCachedMinimalWorkshop } from '@/lib/workshops-query'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { TeamWaitlist } from './team-waitlist'

/**
 * The crash course this page points at. Source-controlled rather than authored
 * in the CMS body: which product the team page promotes is a marketing
 * decision, not a copy edit, and a typo'd slug here would silently downgrade
 * every reader to the waitlist with nothing to alert on.
 */
const CRASH_COURSE_SLUG = 'ai-coding-crash-course'
const CRASH_COURSE_HREF = `/workshops/${CRASH_COURSE_SLUG}`

/**
 * The page's one ask, which is two asks depending on the calendar.
 *
 * Before the crash course opens there is nothing to sell, so the ask is an
 * address and the promise is "you will hear first". After it opens, asking for
 * an address to announce something already announced wastes the most motivated
 * reader on the page — the one who just watched forty minutes and scrolled to
 * the bottom. So the same block becomes a door.
 *
 * The switch is the workshop's OWN published state rather than a date, a flag
 * or an env var. Those are three things that can disagree with the site; this
 * cannot. The moment Matt publishes the crash course, every surface that reads
 * this — here, and anywhere else that adopts it — flips together, and nobody
 * has to remember to come back and edit a page.
 *
 * `getCachedMinimalWorkshop` deliberately, not `getWorkshop`: that one filters
 * visibility through the viewer's ability, so an admin and a visitor would get
 * different answers to "is this live", and the admin would be the one who
 * cannot see the bug.
 */
/**
 * The crash course's cover, on its own, so the closing band can put it ABOVE
 * its heading.
 *
 * Split out rather than rendered inside the ask because of reading order: the
 * cover is a title card naming the product, so it introduces the section the
 * way a photograph introduces an article. Underneath the heading it was an
 * illustration of a point already made; above it, it IS the point, and the
 * heading becomes its caption.
 *
 * Querying twice across this and `CrashCourseCta` costs nothing — the query is
 * `unstable_cache`d and both calls land in the same render pass.
 */
export async function CrashCourseArt() {
	const workshop = await getCachedMinimalWorkshop(CRASH_COURSE_SLUG).catch(
		() => null,
	)
	const image = workshop?.fields.coverImage?.url
	if (!image) return null

	const title = workshop?.fields.title ?? 'The AI Coding Crash Course'

	// Linked, because the destination is real: the crash-course page renders for
	// logged-out visitors (its `unlisted` visibility passes the public filter)
	// and already carries the full sales letter. So the reader who wants more
	// than the band's one paragraph has somewhere to go, and the most engaged
	// person on the page is no longer offered a form as their only next step.
	//
	// The link is on the art alone rather than the whole band: the paragraph
	// beneath it ends in the ask, and wrapping that in a navigation would put a
	// link and a form in competition for the same click.
	return (
		<Link
			href={CRASH_COURSE_HREF}
			aria-label={`${title}: read more`}
			className="focus-visible:ring-ring group block w-full max-w-[240px] rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
		>
			<CourseArt
				src={image}
				alt={workshop?.fields.coverImage?.alt || title}
				className="w-full transition duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:brightness-110 motion-reduce:transition-none"
				sizes="240px"
			/>
		</Link>
	)
}

export async function CrashCourseCta({
	waitlistBody,
	buyHeading,
	buyBody,
	buyLabel = 'Get the crash course',
}: {
	waitlistBody?: string
	buyHeading?: string
	buyBody?: string
	buyLabel?: string
}) {
	const workshop = await getCachedMinimalWorkshop(CRASH_COURSE_SLUG).catch(
		() => null,
	)

	// Published AND public. A published-but-unlisted workshop is a rehearsal,
	// not a launch, and sending readers at it would be sending them at a page
	// the site is not ready to show.
	const isLive =
		workshop?.fields.state === 'published' &&
		workshop.fields.visibility === 'public'

	const courseTitle = workshop?.fields.title ?? 'The AI Coding Crash Course'
	const image = workshop?.fields.coverImage?.url
	// An empty `alt` announces the image as decorative. This one is a title card
	// carrying the product's name, which is the opposite of decorative, so the
	// title stands in when the CMS field is blank.
	const imageAlt = workshop?.fields.coverImage?.alt || courseTitle

	if (!isLive) {
		// Art, then the ask, both sitting directly on the band. No card: the
		// section's heading is the CTA's heading, and a bordered panel here read
		// as an advertisement to skip rather than as the point of the page.
		return (
			// No art here: `CrashCourseArt` renders it above the band's heading,
			// where it introduces the section instead of interrupting the ask.
			<TeamWaitlist
				// Close to the paragraph it completes. The sentence above ends on
				// "drop your info here", so a wide gap before the fields breaks the
				// one link the whole band is built on: the fields ARE the end of
				// that sentence, not the next thing on the page.
				className="-mt-1"
				workshopSlug={CRASH_COURSE_SLUG}
				surface="skills-for-your-team"
				// Normally undefined: the band's body paragraph already ends on the
				// ask, and a second paragraph here would say it twice.
				prompt={waitlistBody}
			/>
		)
	}

	return (
		<div className="border-input bg-card flex flex-col gap-6 rounded-xl border p-6 sm:p-8 md:flex-row md:items-center md:gap-10">
			{image && (
				<CourseArt
					src={image}
					alt={imageAlt}
					className="shrink-0 md:w-64"
					sizes="(max-width: 768px) 100vw, 256px"
				/>
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-4">
				<div className="flex flex-col gap-2">
					<span className={cn(TYPE.groupLabel, 'text-primary')}>
						AI Hero · Out now
					</span>
					<h3
						className={cn(TYPE.panelTitle, 'text-balance font-sans')}
					>
						{buyHeading ?? 'The AI Coding Crash Course is out'}
					</h3>
					<p className={cn(TYPE.lead, 'text-foreground/80')}>
						{buyBody ??
							'Everything in this video, taught properly: the exercises, the codebase to practise on, and seats for the whole team.'}
					</p>
				</div>
				<Link
					href={CRASH_COURSE_HREF}
					className={cn(
						TYPE.meta,
						'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring inline-flex h-12 w-fit items-center justify-center gap-2 rounded-[9px] px-7 font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
					)}
				>
					{buyLabel}
					<ArrowRight className="h-4 w-4" aria-hidden />
				</Link>
			</div>
		</div>
	)
}

/**
 * The course's own cover art, at a fixed width so it frames the ask rather
 * than competing with the video above it. A radius, because it is an object
 * sitting on the page (DESIGN rule 12).
 *
 * 16:9 at every width, never square. The cover is a title card with the course
 * name set across it, so a square crop eats the words and leaves a photo of
 * Matt with half a headline — the one image on the page whose whole job is to
 * say what is being sold, saying nothing.
 */
function CourseArt({
	src,
	alt,
	className,
	sizes = '(max-width: 900px) 100vw, 560px',
}: {
	src: string
	alt: string
	className?: string
	sizes?: string
}) {
	return (
		<div
			className={cn(
				'border-input relative aspect-video w-full overflow-hidden rounded-md border',
				className,
			)}
		>
			<Image src={src} alt={alt} fill sizes={sizes} className="object-cover" />
		</div>
	)
}
