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
 * Pills, per DESIGN rule 12: the shared `SkillsNewsletter.Form` ships squared
 * inputs at `h-14`/`h-16` for the full-page front door, which at homepage
 * scale reads as a different site's form.
 */
export function SkillsCourseCta() {
	return (
		<SkillsNewsletter.Root status="show-form" location="landing_hero_course">
			<div className="flex w-full flex-col items-center gap-3">
				<SkillsNewsletter.Form
					label="Start the free course"
					className="[&_button]:bg-primary [&_button]:text-primary-foreground [&_button]:hover:bg-primary/90 [&_input]:border-foreground/15 [&_input]:bg-muted [&_input]:text-foreground [&_input]:placeholder:text-foreground/60 grid w-full grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] [&_button]:col-span-1 [&_button]:h-11 [&_button]:rounded-full [&_button]:border-0 [&_button]:px-6 [&_button]:text-sm [&_button]:font-semibold [&_input]:h-11 [&_input]:rounded-full [&_input]:border [&_input]:px-5 [&_input]:text-sm [&_label]:hidden"
				/>
				<SkillsNewsletter.Privacy
					className="mt-2 opacity-70"
					// Names the actual commitment. "Unsubscribe at any time" answers a
					// worry the reader has about an open-ended list; this offer is not
					// open-ended, and saying so is a better reassurance than the
					// generic one.
					formMessage="Seven emails, then it stops. Unsubscribe any time."
				/>
			</div>
		</SkillsNewsletter.Root>
	)
}
