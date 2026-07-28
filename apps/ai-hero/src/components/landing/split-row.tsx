import * as React from 'react'

/**
 * Puts two top-level landing blocks side by side on desktop, stacked on
 * mobile. Authored in the CMS body:
 *
 *   <SplitRow>
 *     <NewsletterSection …><NewsletterCta /></NewsletterSection>
 *     <TestimonialDivider …>…</TestimonialDivider>
 *   </SplitRow>
 *
 * Built for pairing an ask with its proof — the newsletter block next to a
 * quote — which is a stronger position for both than the same two things
 * stacked half a screen apart.
 *
 * The newsletter's painted stripe is hidden in here: it is a full-bleed page
 * divider, and at half width it reads as a coloured bar stuck to one column.
 *
 * The column rule comes from the container (`bg-border` + `gap-px`, DESIGN
 * rule 2), not from the children, and the children's own bottom rules are
 * suppressed inside the row: they were drawn for a block that spans the page,
 * and half-width they read as two stray lines. The row draws its own bottom
 * rule instead — under `LandingBody`'s separator scheme the next child's
 * `border-t` lands on the same pixel row, so this cannot double, and it means
 * the row still closes properly if it ever ends up last.
 *
 * Two thirds / one third, not equal halves. The ask is what the row is for;
 * the quote is there to make it easier to say yes to, and given equal width it
 * competed with the form instead of supporting it. Columns are centred against
 * each other rather than stretched, so a short quote sits level with the form
 * rather than floating at the top of a tall empty cell.
 */
export function SplitRow({ children }: { children: React.ReactNode }) {
	const columns = React.Children.toArray(children)

	return (
		<div className="border-border bg-border grid grid-cols-1 gap-px border-b md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] [&_[data-newsletter-stripe]]:hidden [&_section]:border-b-0">
			{columns.map((column, i) => (
				<div
					key={i}
					className="bg-background flex flex-col justify-center"
				>
					{column}
				</div>
			))}
		</div>
	)
}
