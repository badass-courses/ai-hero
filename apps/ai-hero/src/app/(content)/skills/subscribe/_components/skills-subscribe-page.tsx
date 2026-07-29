import * as React from 'react'
import { CldImage } from '@/components/cld-image'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { ProofQuote } from '@/components/landing/proof-grid'
import { TYPE } from '@/components/landing/type'
import { SubscriberCount } from '@/components/subscriber-count'

import { cn } from '@coursebuilder/utils/cn'

import { SkillsCourseConfirmed } from '../../_components/skills-course-confirmed'
import * as SkillsNewsletter from '../../_components/skills-newsletter'
import { type SkillsNewsletterStatus } from '../../_components/skills-newsletter'

/**
 * `/skills/subscribe`, rebuilt against `Skills Subscribe Page.dc.html`.
 *
 * The page makes ONE offer and then spends the rest of its height earning it:
 * hero and signup panel, the seven days in full, who wrote them, who vouches,
 * and a last field for anyone who scrolled the whole thing before deciding.
 *
 * Everything that submits is the app's existing Kit machinery
 * (`SkillsNewsletter.*` → `SubscribeToConvertkitForm` → `SKILLS_FORM_ID`).
 * This file restyles those parts through their `className` slots and does not
 * reimplement any of them, so the confirmation redirect, the `subscribed`
 * tracking call and the one-click "tag me" path are untouched.
 *
 * The 98,000+ figure is `<SubscriberCount />` — live from Kit, never typed in.
 */

/** An inline slash command inside a row title. Mono by category (DESIGN
 *  rule 10), sized relative to the title it sits in rather than pinned to a
 *  step, so the command tracks the title across breakpoints
 *  (`.dttl span.mono { font-size: .88em }` in the prototype). */
function Cmd({ children }: { children: React.ReactNode }) {
	return <span className="font-mono text-[0.88em] font-medium">{children}</span>
}

const CURRICULUM: { title: React.ReactNode; description: string }[] = [
	{
		title: 'Choose your workflow path',
		description:
			'Start with reusable agent workflows instead of one-off prompts.',
	},
	{
		title: (
			<>
				Clarify the work with <Cmd>/grill-with-docs</Cmd>
			</>
		),
		description: 'Find the fuzzy decisions before an agent starts building.',
	},
	{
		title: (
			<>
				Test uncertain ideas with <Cmd>/prototype</Cmd> and <Cmd>/handoff</Cmd>
			</>
		),
		description: 'Make the unknown visible in a small, throwaway context.',
	},
	{
		title: (
			<>
				Turn decisions into <Cmd>/to-spec</Cmd> and <Cmd>/to-tickets</Cmd>
			</>
		),
		description: 'Break large work into reviewable vertical slices.',
	},
	{
		title: 'Run safer AFK agents with Sandcastle',
		description: 'Scoped tasks, isolation, visible logs, and reviewable commits.',
	},
	{
		title: (
			<>
				Review the result with <Cmd>/code-review</Cmd>
			</>
		),
		description: 'Find avoidable mistakes and improve the system around the diff.',
	},
	{
		title: 'Put the full workflow together',
		description: 'Run the loop from fuzzy idea to a better next agent run.',
	},
]

const MATT_AVATAR =
	'https://res.cloudinary.com/total-typescript/image/upload/v1728059672/matt-pocock_eyjjli.jpg'

/** Shared field styling for both forms: 50px controls on the 9px radius step,
 *  card ground, hairline at the input weight (DESIGN rule 2). */
const FIELD_STYLES =
	'[&_input]:border-input [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_input]:h-[50px] [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-[15px] [&_input]:text-[15px] [&_label]:hidden'

const BUTTON_STYLES =
	'[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:font-bold'

export function SkillsSubscribeFrontDoor({
	status,
	location,
}: {
	status: SkillsNewsletterStatus
	location: string
}) {
	return (
		<main className="bg-background text-foreground">
			<Hero status={status} location={location} />
			<Curriculum />
			<Credibility />
			<CompanyLogoGrid
				variant="row"
				className="border-border border-b bg-muted px-[18px] py-9 sm:px-11"
			/>
			<ClosingCta status={status} location={location} />
		</main>
	)
}

/**
 * HERO. Copy column and signup panel side by side, split at the prototype's
 * `minmax(0,1fr) 520px` — the panel is a fixed object, not a proportion, so it
 * keeps its shape as the shell narrows and the words take the slack.
 */
function Hero({
	status,
	location,
}: {
	status: SkillsNewsletterStatus
	location: string
}) {
	return (
		<section className="border-border grid border-b lg:grid-cols-[minmax(0,1fr)_520px]">
			<div className="flex flex-col justify-center px-[18px] py-14 sm:px-11 sm:pb-[72px] sm:pt-[76px]">
				<p className={cn(TYPE.micro, 'text-primary mb-[22px]')}>
					Free 7-day email course
				</p>
				<h1
					className={cn(
						TYPE.displayLanding,
						// 17ch, not the prototype's 15. Same intent — cap the headline
						// so it breaks on its own terms rather than at the column edge
						// — but next/font's DM Sans sets ~10% wider than the variable
						// Google build the mock was drawn against, and at 15ch the line
						// that holds on one row there broke to two here.
						'mb-[22px] max-w-[17ch] text-balance font-sans',
					)}
				>
					AI Skills for Real Engineers
				</h1>
				<p
					className={cn(
						TYPE.leadHero,
						'mb-4 max-w-[34ch] text-pretty text-[color:var(--ah-fg-body)]',
					)}
				>
					Build a repeatable workflow for working with coding agents without
					giving up your engineering standards.
				</p>
				<p
					className={cn(
						TYPE.body,
						'max-w-[44ch] text-pretty text-[color:var(--ah-fg-muted)]',
					)}
				>
					One practical lesson each day. Learn the skill, try it on real work,
					and finish the week with a workflow you can reuse.
				</p>
				<HeroStats />
			</div>

			{/* The panel's ground is the raised band under the hatch, the card
			    inside it is the card surface — two steps, so the form reads as an
			    object resting on the column rather than as a box drawn on the page.
			    Same treatment as `/skills`'s hero panel (`skills-hero.tsx`): these
			    are the same offer, one page apart, so they take the same ground.
			    The card stays `bg-card` (opaque) — a translucent surface lets the
			    diagonals read straight through and the panel becomes a hole. */}
			<div className="border-border bg-muted bg-stripes-muted flex items-center border-t p-8 sm:px-11 sm:py-12 lg:border-l lg:border-t-0">
				<SkillsNewsletter.Root status={status} location={location}>
					<div className="border-input bg-card w-full rounded-lg border p-[30px] pb-8">
						<p
							className={cn(
								TYPE.micro,
								'mb-3.5 text-[color:var(--ah-fg-label)]',
							)}
						>
							Start the course
						</p>
						<h2 className={cn(TYPE.panelTitle, 'mb-[22px] text-balance')}>
							Get lesson one in your inbox
						</h2>
						<SkillsNewsletter.StatusView
							subscribed={<SkillsCourseConfirmed />}
							tagMe={
								<>
									<SkillsNewsletter.TagMeButton
										label="Start the free course"
										className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover h-[52px] rounded-[9px] px-5 text-base font-bold"
									/>
									<Privacy />
								</>
							}
							form={
								<>
									<SkillsNewsletter.Form
										label="Start the free course"
										className={cn(
											'flex w-full flex-col gap-2.5',
											FIELD_STYLES,
											BUTTON_STYLES,
											'[&_button]:h-[52px] [&_button]:px-5 [&_button]:text-base',
										)}
									/>
									<Privacy />
								</>
							}
						/>
					</div>
				</SkillsNewsletter.Root>
			</div>
		</section>
	)
}

/** The privacy note under the panel's form: mono, centred, no badge. */
function Privacy() {
	return (
		<SkillsNewsletter.Privacy
			className="mt-3.5 w-full gap-0 text-center font-mono text-[11.5px] leading-[1.4] text-[color:var(--ah-fg-subtle)] opacity-100 [&_svg]:hidden"
			formMessage="I respect your privacy. Unsubscribe any time."
		/>
	)
}

/**
 * The three numbers under the lead. Two of them are constants of the offer
 * (seven lessons, no account); the middle one is live from Kit, because a
 * subscriber count typed into markup is stale the week it is written.
 *
 * Labels are one or two words. "Lessons, one a day" put the cadence in the
 * label, where it wrapped to two lines and made this figure read longer than
 * the two beside it — the pacing is already the first line of the curriculum
 * section below.
 */
function HeroStats() {
	const stats: { value: React.ReactNode; label: string }[] = [
		{ value: '7', label: 'Lessons' },
		{ value: <SubscriberCount />, label: 'Developers subscribed' },
		{ value: 'Free', label: 'No account needed' },
	]

	return (
		<dl className="border-border mt-10 grid grid-cols-2 gap-x-8 gap-y-6 border-t pt-[26px] sm:flex sm:gap-x-[34px]">
			{stats.map((stat) => (
				<div
					key={stat.label}
					// Natural widths, left-packed on a 34px gap — three short figures
					// read as one line of evidence, where `flex-1` would space them
					// across the column and turn them into three separate claims.
					className="flex min-w-0 flex-col gap-[7px]"
				>
					<dt className="sr-only">{stat.label}</dt>
					<dd className={TYPE.stat}>{stat.value}</dd>
					<p
						className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}
						aria-hidden
					>
						{stat.label}
					</p>
				</div>
			))}
		</dl>
	)
}

/**
 * CURRICULUM. Seven numbered rows plus the "what you'll have" summary, laid
 * out as one hairline grid (`bg-border` + `gap-px`, cells carry their own
 * ground — DESIGN rule 2) so the eight cells land as a clean 2 × 4 with no
 * filler row.
 */
function Curriculum() {
	return (
		<section
			aria-labelledby="curriculum-heading"
			className="border-border border-b px-[18px] py-14 sm:px-11 sm:pb-[76px] sm:pt-[72px]"
		>
			<p className={cn(TYPE.micro, 'text-primary mb-5')}>
				The 7-day curriculum
			</p>
			<h2
				id="curriculum-heading"
				className={cn(TYPE.section, 'mb-3.5 max-w-[26ch] text-balance')}
			>
				From fuzzy idea to a workflow you trust
			</h2>
			<p
				className={cn(
					TYPE.body,
					'mb-[38px] max-w-[62ch] text-pretty text-[color:var(--ah-fg-muted)]',
				)}
			>
				Each day is one skill and one small exercise on work you already have.
				Nothing here is theory you can't run the same afternoon.
			</p>

			<ol className="border-border bg-border grid gap-px overflow-hidden rounded-lg border md:grid-cols-2">
				{CURRICULUM.map((day, index) => (
					<li
						key={index}
						className="bg-background flex gap-4 px-6 pb-[26px] pt-6"
					>
						<span
							className={cn(
								TYPE.command,
								'text-primary w-[26px] flex-none pt-[5px]',
							)}
							aria-hidden
						>
							{String(index + 1).padStart(2, '0')}
						</span>
						{/* `subhead`/`body`, a step up from `cardTitle`/`metaProse`.
						    These cells are the page's actual curriculum — the thing a
						    reader is deciding on — and at 16/14 they read as captions
						    under the 17.5px intro that introduces them. */}
						<div className="min-w-0">
							<h3 className={cn(TYPE.subhead, 'mb-1.5 text-pretty')}>
								<span className="sr-only">Day {index + 1}: </span>
								{day.title}
							</h3>
							<p
								className={cn(
									TYPE.body,
									'text-pretty text-[color:var(--ah-fg-muted)]',
								)}
							>
								{day.description}
							</p>
						</div>
					</li>
				))}
				{/* The eighth cell is the payoff, not a lesson: it sits on the band
				    surface so the grid closes on a different note than it ran. */}
				<li className="flex flex-col justify-center bg-[color:var(--ah-band)] px-6 pb-[26px] pt-6">
					<p className={cn(TYPE.micro, 'text-primary mb-[11px]')}>
						Day 7, what you'll have
					</p>
					<p
						className={cn(
							TYPE.body,
							'text-pretty text-[color:var(--ah-fg-body)]',
						)}
					>
						One written workflow, the slash commands that run it, and a review
						habit that keeps your codebase one an agent still performs well in.
					</p>
				</li>
			</ol>
		</section>
	)
}

/**
 * CREDIBILITY. Who wrote the seven days, and one person vouching for him, on
 * one row. The quote is `ProofQuote` so a testimonial here and a testimonial
 * on the homepage are typographically the same object.
 */
function Credibility() {
	return (
		<section className="border-border bg-muted grid gap-10 border-b px-[18px] py-11 sm:px-11 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-11">
			<div className="flex items-center gap-[18px]">
				<CldImage
					src={MATT_AVATAR}
					alt="Matt Pocock"
					width={52}
					height={52}
					className="size-[52px] flex-none rounded-full object-cover"
				/>
				<div>
					<h2 className={cn(TYPE.subhead, 'mb-[5px] text-balance')}>
						Built from Matt Pocock's working AI skills
					</h2>
					<p
						className={cn(
							TYPE.metaProse,
							'text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						Matt created AI Hero and the practical agent skills taught in this
						course. Before that, Total TypeScript.
					</p>
				</div>
			</div>
			<ProofQuote
				authorName="Guillermo Rauch"
				authorTitle="Vercel CEO"
				authorAvatar="https://res.cloudinary.com/total-typescript/image/upload/v1737463838/workshops/page-6z2ir/qxwhr72flnhn571y4cvg.jpg"
			>
				<p>Matt is one of the best developer educators in the world.</p>
			</ProofQuote>
		</section>
	)
}

/**
 * CLOSING CTA. The same Kit form as the hero, on one line: a reader who got
 * this far has already read the name field once, so this row asks only for the
 * address (the first-name fieldset is hidden rather than removed, because the
 * form component owns its own markup and posts both fields either way).
 */
function ClosingCta({
	status,
	location,
}: {
	status: SkillsNewsletterStatus
	location: string
}) {
	return (
		<section className="border-border grid gap-8 border-b px-[18px] py-14 sm:px-11 sm:pb-16 sm:pt-[60px] lg:grid-cols-[minmax(0,1fr)_480px] lg:items-center lg:gap-12">
			<div>
				<h2 className={cn(TYPE.heading, 'mb-3 max-w-[24ch] text-balance')}>
					Lesson one lands the moment you sign up
				</h2>
				<p
					className={cn(
						TYPE.body,
						'max-w-[52ch] text-pretty text-[color:var(--ah-fg-muted)]',
					)}
				>
					Seven days, then you're on the AI Hero list for new skills and Matt's
					coding letters. Leave any time.
				</p>
			</div>
			<SkillsNewsletter.Root status={status} location={location}>
				<SkillsNewsletter.StatusView
					subscribed={<SkillsCourseConfirmed />}
					tagMe={
						<SkillsNewsletter.TagMeButton
							label="Start the free course"
							className="bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover h-[50px] w-full rounded-[9px] px-[22px] text-[15px] font-bold"
						/>
					}
					form={
						<SkillsNewsletter.Form
							label="Start the free course"
							className={cn(
								// Three across from 900px — name, email, button — the same
								// row the hero form uses. It was one field wide with the name
								// fieldset hidden, which meant the page's last ask collected
								// a different set of data from its first, and Kit got no
								// first name for anyone who scrolled past the hero. Stacks
								// to one column below 900px.
								'grid w-full grid-cols-1 gap-[9px] [&_button]:col-span-1 desk:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_auto]',
								FIELD_STYLES,
								BUTTON_STYLES,
								'[&_button]:h-[50px] [&_button]:whitespace-nowrap [&_button]:px-[22px] [&_button]:text-[15px]',
							)}
						/>
					}
				/>
			</SkillsNewsletter.Root>
		</section>
	)
}
