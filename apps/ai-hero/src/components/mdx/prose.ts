/**
 * The article measure.
 *
 * 70ch is the redesign spec's `--ah-measure`, and it is not a taste call: the
 * two-column article shell (`minmax(0,1fr) 232px`) is sized around it, so a
 * body column that drifts to `max-w-4xl` puts the TOC rail in the wrong place.
 * The four prose wrappers all read it from here instead of each picking their
 * own `max-w-*` step, which is how they drifted apart in the first place.
 *
 * `[&>*:first-child]:mt-0` belongs to the measure rather than to the callers:
 * every one of these wrappers sits directly under a page head that already
 * owns the space above the body.
 */
export const PROSE_MEASURE = 'max-w-[70ch] [&>*:first-child]:mt-0'
