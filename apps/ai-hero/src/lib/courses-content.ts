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
 *
 * v3 (2026-07-28): re-cut for the redesign's direction `1a` (the "spec
 * sheet"). The flagship stopped being a block *under* a masthead and became
 * the hero itself, so the masthead's copy is gone and the cohort's slogan is
 * now the page `h1`. The bookend newsletter is gone too: the hero's waitlist
 * form is the same Kit form making the same ask, and asking twice on a page
 * whose whole argument is one offer was the old order's tell.
 */

/**
 * The hero's copy.
 *
 * `pitchLead` / `pitchTail` are gone. They bracketed the product name so it
 * could be emphasised inside a sentence — which is precisely the invisibility
 * Amy flagged: *"a reader can finish the page not knowing what it is called."*
 * The name is the `h1` now and the cohort's own `description` is the line under
 * it, so a paragraph restating the argument before the ask was the third pass
 * at one idea.
 */
export const FLAGSHIP_HERO = {
	/**
	 * The route's ONE eyebrow, and the only mark on the site that still floats
	 * above a heading attached to nothing.
	 *
	 * It earns it: the headline is the cohort's NAME, so what KIND of thing it
	 * is — a cohort-based course rather than a video course or a book — is a
	 * fact the heading cannot hold and would be clumsy folded into the sentence.
	 * It clears all three gates (`lat.md/decisions#Eyebrows split by
	 * attachment`), so it ships at 70% ink rather than whispering.
	 *
	 * One phrase, not a composed one. It briefly carried the start date too
	 * ("Cohort · Starts 6 Oct"), which put a fact here that the "Next dates"
	 * row below already states — and left the no-date branch reading
	 * "Cohort · Semi-live", which is two labels pretending to be a sentence.
	 */
	eyebrow: 'Cohort-based course',
	/**
	 * The affordance under the cohort artwork in the hero's rail.
	 *
	 * Its own string, not a borrow of `FLAGSHIP_ENROLLING.ctaLabel`. That label
	 * belongs to the primary button, and the image is not a second CTA — it is
	 * the way to read more before deciding, which is a different promise and
	 * should not be dressed as the same one.
	 */
	imageLinkLabel: 'More info',
	/**
	 * Fallbacks for when no cohort resolves at all — no upcoming one and no
	 * latest one. Both the headline and the line under it come off the cohort
	 * normally: the NAME is the headline (Amy: a reader could finish this page
	 * not knowing what the thing is called) and the cohort's own `description`
	 * is the line under it, the same field the cohort page sets in `text-primary`
	 * beneath its title. One product, one sentence, on both pages.
	 */
	fallbackTitle: 'AI Coding for Real Engineers',
	subhead: 'Stop babysitting your agent. Start engineering with it.',
	/** The hairline fact row under the pitch. */
	trainedLabel: 'Engineers trained',
	formatLabel: 'Format',
	formatValue: 'Async lessons + live office hours',
	datesLabel: 'Next dates',
	/**
	 * A cohort can be purchasable without a future start date — no date set
	 * yet, or one already underway and still open. Neither is a waitlist, so
	 * neither may borrow the waitlist's line.
	 */
	datesOpenValue: 'Enrolling now',
} as const

/** The hero's right cell, between cohorts: the waitlist capture. */
export const FLAGSHIP_WAITLIST = {
	/** Anchor for every "join the list" link on the site. */
	anchorId: 'join',
	badge: 'Waitlist open',
	/**
	 * Names the thing on offer: a place in the next cohort, ahead of everyone
	 * else. "Get the dates first" named a calendar — the smallest part of what a
	 * reader is signing up for, and a promise the description under it already
	 * makes in full. It also left the block with nothing that said "cohort",
	 * so the heading was doing no work the badge above it wasn't.
	 */
	heading: 'Be first in line for the next cohort',
	description:
		'Enrollment closes between cohorts and seats go to the waitlist. Join and you get the dates the moment they are set, plus what you need for budget approval.',
	actionLabel: 'Join the waitlist',
	note: 'No spam. Unsubscribe anytime.',
} as const

/** The same cell while a cohort is actually purchasable. */
/**
 * A live discount, surfaced without a price.
 *
 * Deliberately no number beyond the saving: purchasing-power parity makes a
 * displayed price situation-dependent, so any figure rendered here would be
 * wrong for most readers. The discount and the deadline are true for everyone.
 */
export const FLAGSHIP_SALE = {
	label: 'Sale',
	/** Interpolated with the formatted discount, e.g. "30%". */
	claim: (formatted: string) => `Save ${formatted} on this cohort right now.`,
	deadlineLabel: 'Offer ends',
} as const

/**
 * Not a sales state. A buyer landing on /courses mid-cohort should see, before
 * anything else, that the thing they bought is currently on — so this is a
 * strip at the TOP of the page rather than the hero's CTA.
 */
export const FLAGSHIP_RUNNING = {
	label: 'In progress',
	heading: 'Your cohort is on right now',
	body: 'We are inside the window, learning with Matt.',
	ctaLabel: 'Go to the cohort',
} as const

export const FLAGSHIP_ENROLLING = {
	badge: 'Enrollment open',
	heading: 'Seats are open',
	description:
		'A semi-live cohort: async lessons and exercises you run on your own schedule, plus live office hours with Matt when you want a human.',
	ctaLabel: 'See the cohort',
} as const

export const COURSES_DETAILS_EYEBROW = "What you're signing up for"

/**
 * Objection-defusing facts — every line is the canonical support answer.
 * Ordered as the design reads them: cost in hours, then the two anxieties
 * (timezone, pace), then the reassurance that closes.
 */
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
		label: 'Go at your pace',
		body: 'Most people finish inside the cohort window. Plenty stretch it over 4 to 8 weeks instead. Both work.',
	},
	{
		label: 'Yours to keep',
		body: 'Lessons, exercises, the course repo, recordings, transcripts. All of it stays yours after the cohort ends.',
	},
] as const

export const FLAGSHIP_TEAM = {
	heading: 'Bringing your team?',
	body: 'Team seats, bulk discounts, invoicing and procurement: all handled. Start with a single seat if you need to convince your engineering director first.',
	linkLabel: 'See team options',
	href: '/for-your-team',
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
 * The crash course. The workshop (`ai-coding-crash-course`) is draft +
 * unlisted on purpose: its page is a public interest-capture landing with its
 * own "Join Waitlist" Kit form, so its card clicks straight through to that
 * list. Image is fetched live from the workshop resource in page.tsx.
 *
 * It used to have a "Coming next" section to itself. It does not need one: a
 * course that has not shipped announced above the fold of its own section had
 * more of the page than the course you can buy today.
 */
export const COURSES_COMING_NEXT = {
	title: 'AI Coding Crash Course',
	slug: 'ai-coding-crash-course',
	// Shipped 2026-08-17. The card wore "Waitlist open" / "Matt is recording…"
	// into launch week, selling a waitlist for a course you could buy.
	badge: 'Available now',
	description:
		'A self-paced AI coding course you can start any day, no cohort dates required: build production-grade software with agents doing the typing.',
} as const

/**
 * The workshop as the page's hero, for as long as the offer ladder ranks it
 * above the cohort (`next-offer.ts`: a live sale on it, or its waitlist while
 * nothing is purchasable). The cohort does not leave the page — it takes a
 * card in the grid below (`COURSES_NEXT_COHORT_CARD`).
 */
export const COURSES_FEATURED_WORKSHOP = {
	/** Same slot and same reasoning as `FLAGSHIP_HERO.eyebrow`: the headline is
	 *  the course's NAME, so what kind of thing it is goes here. */
	eyebrow: 'Self-paced course',
	badge: 'Available now',
	heading: 'Start today',
	/** Fallback for a workshop authored without a description. */
	description:
		'A self-paced course: lessons and exercises you run on your own schedule, starting the moment you buy.',
	/** Under the ask's heading — distinct from `description`, which can also
	 *  render as the hero's statement when the workshop has none of its own. */
	askDescription:
		'Buy it, open the first lesson, and go — no cohort dates, no schedule to keep.',
	ctaLabel: 'Get the course',
	/** Secondary ask, for the buyer who needs sign-off first — the same
	 *  `/boss/<slug>` letter the workshop's pricing card offers. */
	bossLetterLabel: 'Letter for your boss',
	imageLinkLabel: 'See the course',
	/** Interpolated with the formatted discount, e.g. "$100" or "30%". */
	saleClaim: (formatted: string) => `Save ${formatted} on this course right now.`,
} as const

/**
 * The cohort's card for when the hero features the workshop instead. "Waitlist
 * open" is the honest status: the last run ended, the next has no date, and
 * the cohort page is where the waitlist lives.
 */
export const COURSES_NEXT_COHORT_CARD = {
	badge: 'Waitlist open',
	/** The cohorts shelf's label while this card leads it — "Past cohorts"
	 *  would be a lie about the first row. */
	shelfEyebrow: 'Cohorts',
	fallbackBlurb:
		'The flagship cohort. Join the waitlist on its page and you hear the moment the next dates land.',
} as const

/**
 * Everything that is not the cohort, as one grid. Badges are the honest
 * status of each thing rather than a uniform label: one is not built yet, one
 * costs money, one is free, and flattening that difference is what a "browse
 * our catalog" grid usually gets wrong.
 *
 * `image` values are the same committed Cloudinary assets the nav menu uses
 * (`use-nav-links.tsx`); the crash course's is fetched live because its
 * resource is the one that still changes.
 */
/**
 * The catalog's second shelf. Separate from `COURSES_CATALOG` because that
 * one's note promises "self-paced, start any day" and a finished cohort is
 * neither — these are here so alumni can find their way back, not to be sold.
 */
export const COURSES_PAST_COHORTS = {
	eyebrow: 'Past cohorts',
	badge: 'Cohort ended',
	/** For a cohort authored without a description. */
	fallbackBlurb: 'A past cohort. Open it if you were enrolled.',
} as const

export const COURSES_CATALOG = {
	eyebrow: 'Everything else Matt teaches',
	note: 'self-paced, start any day',
	items: [
		{
			title: 'AI SDK v6 Crash Course',
			href: '/workshops/ai-sdk-v6-crash-course',
			description:
				"Ship your first production agent with Vercel's AI SDK. 94 videos, 59 exercises, 10 modules.",
			badge: 'Available now',
			badgeTone: 'neutral',
			image:
				'https://res.cloudinary.com/total-typescript/image/upload/v1769629206/v6imageforproduct.png',
		},
		{
			title: 'LLM Fundamentals',
			href: '/llm-fundamentals',
			description:
				'The mental model under everything else: tokens, context windows, evals.',
			badge: 'Free',
			badgeTone: 'neutral',
			image:
				'https://res.cloudinary.com/total-typescript/image/upload/v1759305215/llm-fundamentals-thumbnail_2x.jpg',
		},
	],
} as const
