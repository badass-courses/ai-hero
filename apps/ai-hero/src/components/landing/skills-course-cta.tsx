'use client'

import * as React from 'react'
import { api } from '@/trpc/react'

import * as SkillsNewsletter from '@/app/(content)/skills/_components/skills-newsletter'
import type { SkillsNewsletterStatus } from '@/app/(content)/skills/_components/skills-newsletter'
import { SKILLS_COURSE_WAYFINDING } from '@/lib/skills-content'

import { cn } from '@coursebuilder/utils/cn'

import { TYPE } from './type'

/**
 * The homepage's newsletter form, pointed at the free seven-lesson email course
 * instead of the general list.
 *
 * The landing page used to ask for an email and promise "short, practical
 * notes" — a subscription with no shape, competing against every other
 * newsletter someone has already stopped reading. `/skills/subscribe` has a
 * real offer sitting behind the same field: seven days, one lesson each, a
 * workflow at the end. This puts that offer on the homepage rather than
 * leaving it on a page you can only reach if you already went looking.
 *
 * Same form component as `/skills/subscribe`, so it posts to the course's Kit
 * form (`SKILLS_FORM_ID`) and inherits its confirmation flow. A visitor who
 * signs up here and one who signs up there end up in the same place; a second
 * bespoke form would have meant two ways into one course.
 *
 * When the caller does not provide `status`, a client query resolves the
 * subscriber state after hydration. This keeps the homepage static without
 * showing the wrong call to action in its cached HTML.
 *
 * Resized to the button/input radius step: the shared `SkillsNewsletter.Form`
 * ships `h-14`/`h-16` for the full-page front door, which at homepage scale
 * reads as a different site's form.
 */
export function SkillsCourseCta({
	status: forcedStatus,
}: {
	status?: SkillsNewsletterStatus
} = {}) {
	const { data, status: queryStatus } =
		api.ability.getSkillsCourseCtaState.useQuery(undefined, {
			enabled: forcedStatus === undefined,
			staleTime: 5 * 60 * 1000,
			refetchOnWindowFocus: false,
			retry: 1,
		})
	const resolvedStatus: SkillsNewsletterStatus | undefined = data
		? data.state === 'subscribed'
			? 'subscribed'
			: data.state === 'fresh'
				? 'show-form'
				: 'tag-me'
		: undefined
	const status = forcedStatus ?? resolvedStatus

	if (forcedStatus === undefined && queryStatus !== 'success') return null
	if (!status) return null

	return (
		<SkillsNewsletter.Root
			status={status}
			location="landing_hero_course"
			surface="homepage-course"
		>
			<div className="flex w-full flex-col items-start gap-0">
				{/* Field row per `Home Page.dc.html` § MATT + NEWSLETTER: a short
				    name field (130px), the email taking the slack, the button
				    sized to its label, all 46px tall on a 9px gap.

				    `tag-me` is someone already on the list who never took the
				    course: they have nothing to type, so asking for an address we
				    already have is a form they cannot pass. One gold control in the
				    same slot instead, sized to match the submit it replaces. */}
				<SkillsNewsletter.StatusView
					subscribed={
						<SkillsNewsletter.RestartCourse source="landing_hero_course_restart" />
					}
					tagMe={
						<SkillsNewsletter.TagMeButton
							label="Start the free course"
							className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring h-[50px] w-auto rounded-[9px] px-[18px] text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 desk:h-[46px]"
						/>
					}
					form={
						<SkillsNewsletter.Form
							surface="homepage-course"
							label="Start the free course"
							className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-[color:var(--ah-fg-faint)] grid w-full grid-cols-1 gap-[9px] desk:grid-cols-[minmax(0,130px)_minmax(0,1fr)_auto] [&_button]:col-span-1 [&_button]:h-[50px] desk:[&_button]:h-[46px] [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-[18px] [&_button]:text-sm [&_button]:font-bold [&_input]:h-12 desk:[&_input]:h-[46px] [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_label]:hidden"
						/>
					}
				/>
				<div
					className={cn(
						TYPE.metaProse,
						'mt-4 max-w-[70ch] space-y-2 text-[color:var(--ah-fg-muted)]',
					)}
				>
					<p>{SKILLS_COURSE_WAYFINDING.signup}</p>
					<p>{SKILLS_COURSE_WAYFINDING.progression}</p>
				</div>
				<SkillsNewsletter.Privacy
					// Mono, small, unornamented — the prototype's privacy line is a
					// note under the form, not a badge with an icon.
					className="mt-3 gap-0 font-mono text-[11.5px] leading-[1.4] text-[color:var(--ah-fg-subtle)] opacity-100 [&_svg]:hidden"
					// Says what actually happens. An earlier draft read "Seven emails,
					// then it stops", which was a nicer promise and a false one —
					// signing up here subscribes you to the list as well as the
					// course. Reassurance that the product does not honour is worse
					// than no reassurance.
					formMessage="Seven lessons, then you're on the AI Hero list for new skills and Matt's coding letters. Leave any time."
				/>
			</div>
		</SkillsNewsletter.Root>
	)
}
