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
 * Real cohort-student quotes from the [aih] Testimonial threads (condensed
 * faithfully; first names only). Swap or extend here as Matt collects more.
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
] as const

export const COURSES_COMING_NEXT = {
	eyebrow: 'Coming next',
	body: 'A self-paced AI Coding Crash Course is in production right now. The list below hears the moment it ships.',
} as const

export const COURSES_NEWSLETTER = {
	anchorId: 'join',
	title: 'Be first in line when enrollment opens',
	byline:
		'Cohort dates, new course launches, and Matt’s AI coding letters. No spam, unsubscribe anytime.',
} as const
