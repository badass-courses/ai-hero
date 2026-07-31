import * as React from 'react'

import * as SkillsNewsletter from '@/app/(content)/skills/_components/skills-newsletter'
import type { SkillsNewsletterStatus } from '@/app/(content)/skills/_components/skills-newsletter'

/**
 * The homepage's newsletter form, pointed at the free 7-day email course
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
 * `status` is resolved by the caller, on the server.
 *
 * It used to be hardcoded to `show-form` on the grounds that reading the
 * subscriber cookie would make the route dynamic and "the homepage is the one
 * page on the site that must stay cacheable". The homepage has not been
 * cacheable for some time — `app/page.tsx` awaits `searchParams`, so it is
 * rendered per request and is absent from the prerender manifest. The cost that
 * argument was avoiding is already being paid, and paying it bought nothing:
 * a reader who finished the course was still asked to start it.
 *
 * Defaults to `show-form` so a caller that cannot resolve a subscriber (a
 * genuinely static surface, a preview route) still renders the ask rather than
 * hiding it from everyone.
 *
 * Resized to the button/input radius step: the shared `SkillsNewsletter.Form`
 * ships `h-14`/`h-16` for the full-page front door, which at homepage scale
 * reads as a different site's form.
 */
export function SkillsCourseCta({
	status = 'show-form',
}: {
	status?: SkillsNewsletterStatus
} = {}) {
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
				<SkillsNewsletter.Privacy
					// Mono, small, unornamented — the prototype's privacy line is a
					// note under the form, not a badge with an icon.
					className="mt-3 gap-0 font-mono text-[11.5px] leading-[1.4] text-[color:var(--ah-fg-subtle)] opacity-100 [&_svg]:hidden"
					// Says what actually happens. An earlier draft read "Seven emails,
					// then it stops", which was a nicer promise and a false one —
					// signing up here subscribes you to the list as well as the
					// course. Reassurance that the product does not honour is worse
					// than no reassurance.
					formMessage="Seven daily lessons, then my regular updates. Unsubscribe any time."
				/>
			</div>
		</SkillsNewsletter.Root>
	)
}
