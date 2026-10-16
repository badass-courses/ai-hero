import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

/**
 * The rail's way to the cohort's team page, for the states that have no
 * pricing card to carry it. When seats are on sale the card offers the same
 * destination as its own "Buy for your team" button, so this row stays out.
 */
export const CohortTeamLink = ({
	href,
	children = 'Buying for a team? Seats and invoices',
}: {
	href: string
	children?: React.ReactNode
}) => (
	<Link
		href={href}
		className="hover:bg-foreground/[0.04] flex items-center justify-between border-t px-5 py-4 text-sm font-semibold transition-colors"
	>
		{children}
		<ArrowUpRight className="size-4" aria-hidden="true" />
	</Link>
)
