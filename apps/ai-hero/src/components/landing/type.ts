/**
 * The site's type scale, transcribed from the redesign's token spec
 * (`aihero.css` § TYPOGRAPHY). That file is normative: where a component and
 * the spec disagree, the spec wins.
 *
 * Compose these constants instead of writing size classes inline. Each one
 * carries its own leading, tracking and weight, because those are part of the
 * size — a display line at `leading-relaxed` is not the same decision as one
 * at `leading-[0.96]`, and letting callers mix them is how a scale turns back
 * into a scatter.
 *
 * ## The steps
 *
 * | Role      | Desktop | Spec name        | Used for                       |
 * | --------- | ------- | ---------------- | ------------------------------ |
 * | `display` | 76px    | `.ah-h1--hero`   | The home hero `h1`. Nothing else. |
 * | `displayLanding` | 64px | Skills Subscribe § HERO | A single-offer landing page's `h1`. |
 * | `title`   | 52px    | `.ah-h1`         | Page `h1`s.                    |
 * | `article` | 44px    | `.ah-h1--article`| Article and lesson `h1`s.      |
 * | `section` | 44px    | Home § SKILL SYSTEM, § PATHS | The two load-bearing section `h2`s. |
 * | `sectionOffer` | 42px | Home § COHORT  | The cohort `h2`. The page's one offer. |
 * | `sectionClaim` | 40px | Home § MANIFESTO | The argument's `h2`.         |
 * | `sectionByline`| 38px | Home § MATT    | "Hi, I'm Matt Pocock".         |
 * | `sectionQuiet` | 36px | Home § POSTS   | Trailing index heads.          |
 * | `heading` | 34px    | `.ah-h2`         | Section `h2`s outside the home page. |
 * | `rungQuestion` | 25px | Home § PATHS    | An activity rung's question.   |
 * | `panelTitle` | 24px | Home § NEWSLETTER | A bordered panel's own title.  |
 * | `statement`| 24px   | Skills § WHAT IS A SKILL | A section's opening claim, set as a paragraph. |
 * | `subhead` | 20px    | `.ah-h3`         | `h3`s, card and row titles, quotes. |
 * | `cardTitle` | 16px  | `.ah-h4`         | Dense row and cell titles.     |
 * | `quote`   | 20px    | `.ah-quote`      | Pull quotes and testimonials.  |
 * | `lead`    | 18.5px  | `.ah-lead`       | The paragraph under an h1/h2.  |
 * | `leadHero`| 21px    | — (hero markup)  | The hero's lead. Nothing else. |
 * | `body`    | 17.5px  | `.ah-prose p`    | Long-form prose.               |
 * | `meta`    | 14px    | —                | Captions, buttons, inline links. |
 * | `nav`     | 13.5px  | `.ah-sidebar__item` | A top-level sidebar/nav row. |
 * | `metaSm`  | 13px    | —                | Attributions, footer links, nested nav rows. |
 * | `metaMono`| 13px    | —                | The mono sibling of `metaSm`.  |
 * | `statSm`  | 20px    | Skills § HEAD    | The mono numeral in a stat strip. |
 * | `eyebrow` | 11px    | `.ah-label`*     | The mono uppercase eyebrow. Rare. |
 * | `badge`   | 10px    | —                | A kind or status marker, in a BADGE_* container. |
 * | `groupLabel` | 11px | —                | The label over a list. No caps, no tracking. |
 * | `statLabel` | 11px  | —                | The caption UNDER a numeral.   |
 * | `metaMark`| 12px    | —                | A duration, count, date or byline on a row. |
 * | `navNum`  | 11px    | `.ah-sidebar__num`* | The mono numeral in a nav row. |
 *
 * Display sizes step down about a third on mobile, per the spec's note.
 *
 * \* The two starred steps are the only places this scale overrides the spec:
 * both are 9.5px there and 11px here. See `eyebrow` for why.
 *
 * ## Weights
 *
 * Headings are **700**. The spec has no medium-weight heading: at these
 * tracking values a 500 display line reads as a different typeface rather than
 * as restraint. `font-medium` belongs to UI text and mono numerals,
 * `font-normal` to prose.
 *
 * ## Families
 *
 * DM Sans and JetBrains Mono. Mono is not decoration — it marks a category:
 * labels, commands, durations, counts and stats are always mono, and nothing
 * else is.
 */

export const TYPE = {
	/** Home hero `h1`. One per site. */
	display:
		'text-[2.75rem] font-bold leading-[1.0] tracking-[-0.04em] sm:text-[3.5rem] lg:text-[4.75rem] lg:leading-[0.96] lg:tracking-[-0.042em]',
	/**
	 * A single-offer landing page's `h1` (`Skills Subscribe Page.dc.html`
	 * § HERO). One step under the home hero and one above a generic page `h1`.
	 *
	 * It needs its own step because the two neighbours are both wrong for it.
	 * `display` is the homepage's masthead, which runs the full shell; a
	 * landing hero shares its row with a signup panel and at 76px the headline
	 * wraps to three lines beside it. `title` is the size a page wears when the
	 * page is a container for other things, and here the headline *is* the
	 * offer, so dropping to 52px makes the panel next to it read as the louder
	 * half. Same leading and tracking as `display` because it is the same kind
	 * of line, set smaller.
	 */
	displayLanding:
		'text-[2.5rem] font-bold leading-[1.0] tracking-[-0.038em] sm:text-[3.25rem] lg:text-[4rem] lg:leading-[1.0] lg:tracking-[-0.042em]',
	/** Page `h1` outside the home hero. */
	title:
		'text-[2.125rem] font-bold leading-[1.04] tracking-[-0.032em] sm:text-[2.75rem] lg:text-[3.25rem] lg:leading-[1.02] lg:tracking-[-0.036em]',
	/** Article and lesson `h1`. */
	article:
		'text-[2rem] font-bold leading-[1.06] tracking-[-0.03em] sm:text-[2.5rem] lg:text-[2.75rem] lg:leading-[1.04] lg:tracking-[-0.034em]',
	/**
	 * The home page's section ladder.
	 *
	 * `.ah-h2` (34px) is the app's generic section head, and for a while every
	 * home section used it. The prototype does not: it sizes each section head
	 * to how much of the page's argument that section is carrying, and the six
	 * of them run 44 / 44 / 42 / 40 / 38 / 36. Flattened to one step the page
	 * reads as six equal announcements, which is the note the design got back.
	 *
	 * Each constant below is one of those measured values (`Home Page.dc.html`),
	 * named for the section that earns it rather than for its number, so a new
	 * section has to pick a rank instead of inventing a seventh size.
	 *
	 * Desktop is the spec value; the two steps below it are the spec's mobile
	 * reduction (about a third) and a midpoint, so callers never write a
	 * breakpoint.
	 */
	/** The two load-bearing home sections: the skill system, and the paths. */
	section:
		'text-[1.875rem] font-bold leading-[1.08] tracking-[-0.028em] sm:text-[2.25rem] lg:text-[2.75rem] lg:leading-[1.04] lg:tracking-[-0.032em]',
	/** The cohort. The one paid offer on the page, one step under the system. */
	sectionOffer:
		'text-[1.75rem] font-bold leading-[1.08] tracking-[-0.028em] sm:text-[2.125rem] lg:text-[2.625rem] lg:leading-[1.04] lg:tracking-[-0.032em]',
	/** The manifesto's claim. Set a touch looser: it is a sentence, not a name. */
	sectionClaim:
		'text-[1.75rem] font-bold leading-[1.1] tracking-[-0.026em] sm:text-[2.0625rem] lg:text-[2.5rem] lg:leading-[1.08] lg:tracking-[-0.03em]',
	/** "Hi, I'm Matt Pocock" — the byline section. */
	sectionByline:
		'text-[1.625rem] font-bold leading-[1.1] tracking-[-0.026em] sm:text-[2rem] lg:text-[2.375rem] lg:leading-[1.05] lg:tracking-[-0.03em]',
	/** Trailing index heads: the posts grid, and anything else that lists. */
	sectionQuiet:
		'text-[1.625rem] font-bold leading-[1.1] tracking-[-0.026em] sm:text-[1.875rem] lg:text-[2.25rem] lg:leading-[1.05] lg:tracking-[-0.03em]',
	/** Section `h2` outside the home page. */
	heading:
		'text-2xl font-bold leading-[1.08] tracking-[-0.028em] sm:text-[1.75rem] lg:text-[2.125rem] lg:leading-[1.06] lg:tracking-[-0.03em]',
	/**
	 * An activity rung's question (`Home Page.dc.html` § PATHS). A step above
	 * `subhead`, because a rung's question is the thing a reader is scanning
	 * the section for — at `h3` size the four of them read as sub-labels of the
	 * section head rather than as four doors.
	 */
	rungQuestion:
		'text-[1.25rem] font-bold leading-[1.2] tracking-[-0.022em] sm:text-[1.375rem] lg:text-[1.5625rem] lg:leading-[1.15] lg:tracking-[-0.025em]',
	/**
	 * A bordered panel's own title (`Home Page.dc.html` § MATT + NEWSLETTER).
	 *
	 * Between `subhead` and `heading`, and it needs to be: a panel sitting
	 * inside a section has to out-rank the `h3`s around it without reading as a
	 * second section head, and at 20px the newsletter's ask looked like a
	 * caption on Matt's bio rather than the offer it is.
	 */
	panelTitle:
		'text-[1.3125rem] font-bold leading-[1.15] tracking-[-0.02em] sm:text-[1.5rem] sm:tracking-[-0.022em]',
	/**
	 * A section's opening claim, set as a paragraph (`Skills Page.dc.html`
	 * § WHAT A SKILL IS: 24px / 1.4 / 500).
	 *
	 * Not `lead`: a lead sits *under* a heading and yields to it, and this line
	 * replaces the heading — the section opens on a 9.5px eyebrow and then says
	 * the whole argument in three sentences. At `lead`'s 18.5px that paragraph
	 * reads as a caption on a label. Not `panelTitle` either, which is the same
	 * 24px but set at heading leading (1.15) and weight (700): three lines of
	 * prose at those values is a slab, not a sentence.
	 */
	statement:
		'text-[20px] font-medium leading-[1.4] tracking-[-0.018em] sm:text-[22px] lg:text-[24px] lg:tracking-[-0.02em]',
	/** `h3`, card and row titles, pull quotes. */
	subhead: 'text-lg font-bold leading-[1.2] tracking-[-0.02em] sm:text-xl',
	/** Dense row and cell titles — the spec's `h4`. */
	cardTitle: 'text-base font-bold leading-[1.3] tracking-[-0.018em]',
	/**
	 * Pull quotes and testimonials (`.ah-quote`). Same size as `subhead` but
	 * set looser: a quote is read as a sentence, and heading leading breaks it
	 * into slabs.
	 *
	 * Source Serif 4, roman and regular. It used to be bold italic DM Sans —
	 * two typographic shouts doing the job that a change of voice should do
	 * quietly. The serif marks "someone else is talking" on its own, so the
	 * weight and the slant both come off. The negative tracking goes with them:
	 * it is a tight-set-sans device and it crowds a serif.
	 */
	quote:
		'font-serif text-[18px] font-normal leading-[1.45] tracking-[-0.005em] sm:text-[20px]',
	/**
	 * The same voice, one step up, for a testimonial set INSIDE article prose.
	 *
	 * `quote` is sized for a card or a grid cell, where the surface already
	 * frames it. Dropped into a column of 17px body copy it has no frame, and a
	 * serif at 400 reads optically lighter than the sans around it — at the same
	 * nominal size it looks like a smaller aside rather than a change of
	 * speaker. The step up is what makes it read as an interruption.
	 */
	quoteProse:
		'font-serif text-[21px] font-normal leading-[1.45] tracking-[-0.005em] sm:text-[24px]',
	/**
	 * The paragraph under an `h1` or `h2`. Prose sitting beneath a display
	 * line, so it stays at normal weight and yields to it.
	 */
	lead: 'text-[17px] font-normal leading-[1.55] sm:text-[18.5px]',
	/**
	 * The hero's lead only. A step above `lead`, because it is the one
	 * paragraph on the site that has to hold its own under 76px of display
	 * type — at 18.5px it read as a caption hanging off the headline rather
	 * than as the sentence that finishes it (`Home Page.dc.html` § HERO).
	 */
	leadHero:
		'text-[17px] font-normal leading-[1.45] sm:text-[19px] lg:text-[21px]',
	/** Long-form prose. */
	body: 'text-[16.5px] leading-[1.68] sm:text-[17.5px]',
	/** Prose that needs to sit tighter — list rows, dense stacks. */
	bodyTight: 'text-base font-medium leading-snug',
	/** Captions, buttons, inline links. */
	meta: 'text-sm font-medium leading-snug',
	/**
	 * A top-level navigation row — the hub sidebar's items (`.ah-sidebar__item`).
	 *
	 * Half a pixel under `meta`, and the half matters: a sidebar is a column of
	 * thirty near-identical lines, and at 14px they read as a second column of
	 * body copy competing with the page. 13.5/1.4 is the prototype's measured
	 * value and it settles the list back into chrome. Carries no weight, so the
	 * active row can take `font-medium` while the rest stay normal.
	 */
	nav: 'text-[13.5px] leading-[1.4]',
	/** Caption prose (not a control), so it stays at normal weight. */
	metaProse: 'text-sm leading-relaxed',
	/**
	 * The step under `meta`: 13px, set tight (1.35).
	 *
	 * Three places in the prototype are 13px and none of them is a control —
	 * a testimonial's attribution (name at 500, role under it), the footer's
	 * bottom-bar links, and the theme control beside them. At `meta`'s 14px
	 * they each sat a hair too close to body text and the footer read as a
	 * paragraph of links. Carries no weight of its own so an attribution's name
	 * can take `font-medium` while its role stays normal.
	 */
	metaSm: 'text-[13px] leading-[1.35]',
	/**
	 * The mono sibling of `metaSm`, for the footer's Agents column
	 * (`sitemap.md`, `llms.txt`, `skills.md`, `rss.xml`). These are filenames,
	 * so they are mono by category (rule 10) — but they are footer links, not
	 * commands, and `command` at 12px set them a step smaller than the sans
	 * columns beside them.
	 */
	metaMono: 'font-mono text-[13px] leading-[1.35]',
	/**
	 * The eyebrow, and the four roles that used to hide inside it.
	 *
	 * There used to be one constant here — `micro` — used 87 times across 46
	 * files. Raising it from 9.5px to 11px (2026-07-29) made the texture bigger
	 * rather than smaller, because texture is a function of **count and
	 * attachment**, not size. A mark floating above a heading, a kind marker on
	 * a card, a label over a list, a caption under a numeral and a duration in a
	 * row are five different jobs; one constant made them one visual event
	 * repeated eighty-seven times.
	 *
	 * Split by what the mark attaches to. Only the first floats.
	 *
	 * A mark earns `eyebrow` when it carries a fact the heading can't hold, that
	 * isn't a property of a thing already on screen, and it is alone on the
	 * screen. Budget: ≤8 site-wide, roughly one per top-level route.
	 */
	/** Floats above a heading, attached to nothing. ≤1 per viewport, ≤2 per route. */
	eyebrow:
		'font-mono text-[11px] font-medium uppercase leading-[1.4] tracking-[0.16em] text-foreground/70 dark:text-foreground/65 mb-3',
	/** Attaches to itself, via a container. Pair with a BADGE_* container. */
	badge:
		'font-mono text-[10px] font-medium uppercase leading-none tracking-[0.10em]',
	/** Attaches to the list beneath it. No uppercase, no tracking — deliberate. */
	groupLabel:
		'font-mono text-[11px] font-medium leading-[1.4] tracking-normal text-muted-foreground',
	/** Attaches to the numeral ABOVE it. Caption position, always below the number. */
	statLabel:
		'font-mono text-[11px] font-medium uppercase leading-[1.35] tracking-[0.12em] text-muted-foreground mt-1.5',
	/**
	 * Attaches to its card or row. Durations, counts, dates, bylines.
	 *
	 * Sits alongside `command`, which is also 12px mono. They differ in weight
	 * and that is the point: `command` is `font-medium` because a slash command
	 * is a thing you type; `metaMark` is `font-normal` because a duration is a
	 * thing you read. Do not merge them.
	 */
	metaMark:
		'font-mono text-[12px] font-normal leading-[1.4] tracking-normal text-muted-foreground',
	/**
	 * The mono numeral leading a nav row (`.ah-sidebar__num`) — a lesson's
	 * position, a section's index.
	 *
	 * `micro`'s size and weight, but none of its eyebrow behaviour: a numeral is
	 * not a label, so it takes no uppercase and no 0.14em tracking (which pulls
	 * "3.2" apart into three characters). Tabular so a column of them lines up.
	 */
	navNum: 'font-mono text-[11px] font-medium leading-none tabular-nums',
	/** Slash commands, durations, counts. Mono because they are data. */
	command: 'font-mono text-xs font-medium',
	/** Stats and numerals. */
	stat: 'font-mono text-2xl font-medium leading-none tracking-[-0.02em] sm:text-[26px]',
	/**
	 * The step under `stat` (`Skills Page.dc.html` § HEAD: 20px / 500).
	 *
	 * `stat` is a single headline number carrying a section on its own (the
	 * cohort's "8,500+"). A strip of three side by side is read as a row of
	 * facts, and at 26px the three of them out-shout the `h1` two lines above.
	 * Same family, weight and tracking, one step down.
	 */
	statSm:
		'font-mono text-[20px] font-medium leading-none tracking-[-0.02em] tabular-nums',
} as const

/**
 * The containers a `TYPE.badge` sits in. A badge attaches to itself, and the
 * container is how it does that — the type constant carries no surface of its
 * own, so a bare `TYPE.badge` is always a mistake.
 *
 * Semantic tokens only, so both themes ride the same declaration. The gold
 * stays a fill and is never used as text (DESIGN rule 7).
 */
export const BADGE_SOLID =
	'bg-primary text-primary-foreground px-[7px] py-[5px] rounded-[4px]'
export const BADGE_NEUTRAL =
	'bg-foreground/10 text-foreground px-[7px] py-[5px] rounded-[4px]'
export const BADGE_OUTLINE =
	'border border-border text-foreground px-[7px] py-[5px] rounded-[4px]'
