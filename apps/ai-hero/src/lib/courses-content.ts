/**
 * Editorial config for the /courses "Learn with Matt" page — the single
 * place to tune copy without touching layout.
 *
 * v2 (2026-07-14): grounded in voice-of-customer mining from support
 * conversations (Front, AI Hero inbox) and the [aih] internal threads:
 * the page centers on the ONE existing product (the flagship cohort) with
 * real metadata and defuses the top documented objections in flow (time
 * commitment 5-8 hrs/wk, timezone/async anxiety, keep-the-materials,
 * own-pace, team purchasing, waitlist-as-dead-end). The speculative tier
 * roadmap was cut per Vojta: "great design work on currently existing
 * content". Testimonials are real cohort-student quotes Matt collected in
 * the [aih] Testimonial threads (first names only).
 */

export const COURSES_HERO = {
	eyebrow: 'Courses',
	title: 'Learn with Matt',
	intro:
		'You can already code. The gap is getting an agent to write code you would put your name on. These courses teach the workflow Matt uses every day: real engineering with agents, not vibe coding.',
} as const

export const FLAGSHIP_SECTION = {
	eyebrow: 'The flagship cohort',
	heading: 'Stop babysitting your agent. Start engineering with it.',
	strapline:
		'AI Coding for Real Engineers is a semi-live cohort: async lessons and exercises you run on your own schedule, plus live office hours with Matt when you want a human.',
} as const

export const FLAGSHIP_WAITLIST = {
	badge: 'Waitlist open',
	description:
		'Enrollment is closed between cohorts, and seats go to the waitlist first. Join it and you get the dates the moment they are set, with everything you need to get budget approved.',
} as const

/** Objection-defusing facts — every line is the canonical support answer. */
export const FLAGSHIP_FACTS = [
	{
		label: 'Fits a full-time job',
		body: 'Plan on 5 to 8 hours a week. Lessons and exercises are async: you schedule them, not us.',
	},
	{
		label: 'Timezone friendly',
		body: 'Office hours run in morning and evening slots, and every session is recorded with transcripts. Send questions ahead if you cannot make it live.',
	},
	{
		label: 'Yours to keep',
		body: 'Lessons, exercises, the course repo, recordings, transcripts. All of it stays yours after the cohort ends.',
	},
	{
		label: 'Your pace is fine',
		body: 'Most people finish inside the cohort window. Plenty stretch it over 4 to 8 weeks instead. Both work.',
	},
] as const

export const FLAGSHIP_TEAM = {
	heading: 'Bringing your team?',
	body: 'Team seats, bulk discounts, invoicing and procurement: all handled. Start with a single seat if you need to convince your engineering director first.',
	linkLabel: 'See team options',
	href: '/for-your-team',
} as const

/**
 * Copy for the stat band welded under the flagship row. Values render live
 * (alumni count from cohort-stats.ts, enrollment state from the page fetch).
 */
export const FLAGSHIP_STATS = {
	trainedLabel: 'Engineers trained',
	trainedSub: 'Across every cohort so far',
	enrollmentLabel: 'Enrollment',
	openValue: 'Open now',
	openSub: 'Dates and price on the cohort page',
	waitlistValue: 'Waitlist open',
	waitlistSub: 'The list gets the dates first',
} as const

export const COURSES_TESTIMONIALS_EYEBROW = 'From past cohorts'

/**
 * Real cohort-student quotes. The first two come from the [aih] Testimonial
 * threads; the rest are verbatim answers to "What was the most valuable part
 * of the cohort for you?" in the post-cohort Completion Survey
 * (`survey-1rd1m`, 45 essay responses), condensed faithfully. First names
 * only, matching how Matt has published these before.
 *
 * Ordered so the first pair carries the emotional claim and the rest answer
 * "what did you actually get" from different angles — a system rather than
 * tips, planning over vibe coding, the whole flow, holistic vs piecemeal.
 * Six is deliberate: two quotes read as the only two that exist.
 */
export const COURSES_TESTIMONIALS = [
	{
		quote:
			'This content is changing my career. It is undeniably maxing out my potential as a developer. The idea that I could plan and build something this big in a couple of hours blows my mind.',
		author: 'Heath, 15 years in industry',
	},
	{
		quote:
			'A genuine turning point for my career. I was a tactical developer, focused on the grind of writing the best lines possible. Now I let AI handle the tactical execution and focus on architecture and the big picture.',
		author: 'Serge, cohort graduate',
	},
	{
		quote:
			'A working system for using Claude, beyond just tips for getting AI to write code. The planning and tracer bullet breakdown does not only improve code quality, it gives a really good framework for tackling feature tasks. I wish I knew it before AI could help.',
		author: 'Daniel',
	},
	{
		quote:
			'Learning how to plan with AI instead of just vibe coding. It is like when CI/CD started to become a thing: you realise there is so much you can automate.',
		author: 'Phil',
	},
	{
		quote:
			'My previous experience was using AI to think about one thing over here, solve an issue over there. This more holistic approach feels much more sensible, secure and workable.',
		author: 'Richard',
	},
	{
		quote:
			'I came for the sandboxing with Ralph loops, and ended up really enjoying the whole flow: PRDs, to phases, to GitHub issues the loops could work on.',
		author: 'Bo',
	},
] as const

/**
 * The crash course pre-launch row. The workshop (`ai-coding-crash-course`) is
 * draft + unlisted on purpose: its page is a public interest-capture landing
 * with its own "Join Waitlist" Kit form, so the row clicks straight through
 * to that list. Image is fetched live from the workshop resource in page.tsx.
 */
export const COURSES_COMING_NEXT = {
	eyebrow: 'Coming next',
	title: 'AI Coding Crash Course',
	slug: 'ai-coding-crash-course',
	typeLabel: 'Self-paced course · In production',
	badge: 'Waitlist open',
	description:
		'Matt is recording a self-paced AI coding course you can start any day, no cohort dates required. Join the waitlist and you hear the moment it ships.',
} as const

export const COURSES_NEWSLETTER = {
	anchorId: 'join',
	title: 'Be first in line when enrollment opens',
	byline:
		'Cohort dates, new course launches, and Matt’s AI coding letters. No spam, unsubscribe anytime.',
} as const
