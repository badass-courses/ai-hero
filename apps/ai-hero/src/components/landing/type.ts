/**
 * The landing page's type scale. Five sizes, three weights, two families.
 *
 * Before this, the landing components between them used nine Tailwind size
 * steps plus arbitrary `text-[10px]` and `text-[11px]` values, five weights,
 * and a scatter of `leading-*` / `tracking-*` combinations chosen per
 * component. Nothing was wrong in isolation; together they meant two headings
 * a screen apart could differ by one step for no reason a reader could name.
 *
 * Compose these instead of writing size classes inline. Each constant carries
 * its own leading and tracking, because those are part of the size — a
 * display line at `leading-relaxed` is not the same typeface decision as one
 * at `leading-[1.05]`, and letting callers mix them is how the scatter came
 * back last time.
 *
 * ## The five sizes
 *
 * | Role      | Steps                              | Used for                          |
 * | --------- | ---------------------------------- | --------------------------------- |
 * | `display` | 4xl → 5xl → 3.5rem                 | The hero `h1`. Nothing else.      |
 * | `heading` | 3xl → 4xl                          | Section `h2`s.                    |
 * | `subhead` | xl → 2xl                           | `h3`s, card and row titles, quotes |
 * | `body`    | base                               | Prose, list rows.                 |
 * | `meta`    | sm                                 | Captions, buttons, inline links.  |
 *
 * Plus `micro`: the mono uppercase eyebrow, at `text-xs`. It is the only
 * place uppercase and `tracking-wider` are allowed, and it shares `meta`'s
 * job at a smaller optical size, which is why it is not a sixth step in the
 * table above.
 *
 * ## Weights
 *
 * `font-medium` for headings, `font-semibold` for titles and UI emphasis.
 * `font-bold` exists for exactly one thing: the emphasised span in the hero
 * `h1`. `font-light` and `font-normal` are gone — at these sizes they read as
 * a rendering fault on a dark background rather than as a choice.
 *
 * ## Families
 *
 * Geist and Geist Mono, per DESIGN.md rule 10. Mono appears in two places
 * only: `micro` labels, and slash commands (which are literally code). Italic
 * appears in one: pull quotes.
 */

export const TYPE = {
	/** Hero `h1`. One per page. */
	display:
		'text-4xl font-medium leading-[1.05] tracking-tight sm:text-5xl lg:text-[3.5rem]',
	/** Section `h2`. */
	heading: 'text-3xl font-medium leading-tight tracking-tight sm:text-4xl',
	/** `h3`, card and row titles, pull quotes. */
	subhead: 'text-xl font-semibold leading-tight tracking-tight sm:text-2xl',
	/** Prose and list rows. */
	body: 'text-base leading-relaxed',
	/** Prose that needs to sit tighter — list rows, dense stacks. */
	bodyTight: 'text-base font-medium leading-snug',
	/** Captions, buttons, inline links. */
	meta: 'text-sm font-medium leading-snug',
	/** Caption prose (not a control), so it stays at normal weight. */
	metaProse: 'text-sm leading-relaxed',
	/** The mono uppercase eyebrow. The only uppercase on the page. */
	micro: 'font-mono text-xs font-medium uppercase tracking-wider',
	/** Slash commands. Mono because they are code you type at an agent. */
	command: 'font-mono text-xs font-medium',
} as const
