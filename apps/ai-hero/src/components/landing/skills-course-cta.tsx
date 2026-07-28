import * as React from 'react'

import * as SkillsNewsletter from '@/app/(content)/skills/_components/skills-newsletter'

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
 * `status="show-form"` is fixed rather than resolved from the subscriber
 * cookie. `/skills/subscribe` reads the cookie to offer already-subscribed
 * visitors a one-click "tag me" button, but that read makes the route
 * dynamic — and the homepage is the one page on the site that must stay
 * cacheable. An existing subscriber submitting the form again is handled
 * correctly by Kit; an uncacheable homepage is not.
 *
 * Resized to the button/input radius step: the shared `SkillsNewsletter.Form`
 * ships `h-14`/`h-16` for the full-page front door, which at homepage scale
 * reads as a different site's form.
 */
export function SkillsCourseCta() {
	return (
		<SkillsNewsletter.Root status="show-form" location="landing_hero_course">
			<div className="flex w-full flex-col items-start gap-0">
				{/* Field row per `Home Page.dc.html` § MATT + NEWSLETTER: a short
				    name field (130px), the email taking the slack, the button
				    sized to its label, all 46px tall on a 9px gap. */}
				<SkillsNewsletter.Form
					label="Start the free course"
					className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-[color:var(--ah-fg-faint)] grid w-full grid-cols-1 gap-[9px] sm:grid-cols-[minmax(0,130px)_minmax(0,1fr)_auto] [&_button]:col-span-1 [&_button]:h-[46px] [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-[18px] [&_button]:text-sm [&_button]:font-bold [&_input]:h-[46px] [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_label]:hidden"
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
