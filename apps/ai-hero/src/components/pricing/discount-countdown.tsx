'use client'

import Countdown from 'react-countdown'

/**
 * "3 days" / "2 hours" / "14 minutes" until a coupon expires.
 *
 * Extracted from `mdx-components.tsx`, which re-exports it unchanged so MDX
 * keeps working. It lives on its own because non-MDX callers — the `/courses`
 * hero — need one line of countdown and would otherwise pull the entire MDX
 * client bundle, with its contexts, effects and every component the article
 * renderer knows about, into a page that renders none of them.
 *
 * Coarse on purpose: the largest surviving unit, not a ticking clock until the
 * final minute. A reader needs to know whether they have days or minutes.
 */
export const DiscountCountdown = ({ date }: { date: Date }) => {
	return (
		<Countdown
			date={date}
			renderer={({ days, hours, minutes, seconds, completed }) => {
				if (completed) {
					return 'Offer has ended'
				}
				return (
					<>
						{days > 1 ? (
							<>
								{days} {days === 1 ? 'day' : 'days'}
							</>
						) : hours > 1 ? (
							<>
								{days > 0 && (
									<>
										{days} {days === 1 ? 'day' : 'days'},{' '}
									</>
								)}
								{hours} {hours === 1 ? 'hour' : 'hours'}
							</>
						) : minutes > 1 ? (
							<>
								{days > 0 && (
									<>
										{days} {days === 1 ? 'day' : 'days'},{' '}
									</>
								)}
								{hours > 0 && (
									<>
										{hours} {hours === 1 ? 'hour' : 'hours'},{' '}
									</>
								)}
								{minutes} {minutes === 1 ? 'minute' : 'minutes'}
							</>
						) : (
							<>
								{days > 0 && (
									<>
										{days} {days === 1 ? 'day' : 'days'},{' '}
									</>
								)}
								{hours > 0 && (
									<>
										{hours} {hours === 1 ? 'hour' : 'hours'},{' '}
									</>
								)}
								{minutes > 0 && (
									<>
										{minutes} {minutes === 1 ? 'minute' : 'minutes'}, and{' '}
									</>
								)}
								{seconds} {seconds === 1 ? 'second' : 'seconds'}
							</>
						)}
					</>
				)
			}}
		/>
	)
}
