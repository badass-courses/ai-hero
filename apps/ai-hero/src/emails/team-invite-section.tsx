import * as React from 'react'
import { Link, Text } from '@react-email/components'

/**
 * The bulk buyer's invite block: the team invite link to forward, the
 * one-person-per-seat rule, and where to manage seats. Buyer emails only;
 * seat claimers never get this.
 */
export default function TeamInviteSection({
	inviteUrl,
	teamUrl,
	textStyle,
	linkStyle,
}: {
	inviteUrl?: string
	teamUrl: string
	textStyle?: React.CSSProperties
	linkStyle?: React.CSSProperties
}) {
	const teamUrlLabel = teamUrl.replace(/^https?:\/\//, '')
	return (
		<>
			{inviteUrl ? (
				<>
					<Text style={textStyle}>
						Share this link with your team. Each person signs in through it to
						claim a seat:
					</Text>
					<Text style={textStyle}>
						<Link href={inviteUrl} style={linkStyle}>
							{inviteUrl}
						</Link>
					</Text>
					<Text style={textStyle}>
						Each seat is for one person and can't be moved to someone else
						later. If you're joining too, use the same link to claim your own
						seat.
					</Text>
				</>
			) : (
				<Text style={textStyle}>
					Each seat is for one person and can't be moved to someone else later.
					If you're joining too, claim your own seat from your team page.
				</Text>
			)}
			<Text style={textStyle}>
				You can see who has claimed a seat, and invite a manager, at{' '}
				<Link href={teamUrl} style={linkStyle}>
					{teamUrlLabel}
				</Link>
				.
			</Text>
		</>
	)
}
