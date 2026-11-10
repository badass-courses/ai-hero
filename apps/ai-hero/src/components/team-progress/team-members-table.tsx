import { TYPE } from '@/components/landing/type'
import type { LearningTeamMember } from '@/lib/analytics/learning-teams'

const number = new Intl.NumberFormat('en-US')

function day(value: string | null) {
	return value
		? new Date(value).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric',
				timeZone: 'America/Los_Angeles',
			})
		: '—'
}

/**
 * Member rows for one team: PII, so callers render it only for AI Hero admins
 * or the team's own managers. Unredeemed seats are a count under the table,
 * never rows with zero progress.
 */
export function TeamMembersTable({
	members,
	unredeemedSeats,
	caption,
}: {
	members: LearningTeamMember[]
	unredeemedSeats: number | null
	caption: string
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="border-border overflow-x-auto border">
				<table className="w-full min-w-[640px] text-left">
					<caption className="sr-only">{caption}</caption>
					<thead className={`${TYPE.statLabel} bg-muted/40`}>
						<tr>
							<th scope="col" className="px-3 py-2 font-medium">
								Learner
							</th>
							<th scope="col" className="px-3 py-2 font-medium">
								Seat redeemed
							</th>
							<th scope="col" className="px-3 py-2 font-medium">
								Last active
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Lessons done
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Workshops started
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Workshops done
							</th>
						</tr>
					</thead>
					<tbody className={`${TYPE.metaSm} tabular-nums`}>
						{members.length === 0 ? (
							<tr className="border-border border-t">
								<td colSpan={6} className="text-muted-foreground px-3 py-3">
									No seats redeemed yet.
								</td>
							</tr>
						) : (
							members.map((member) => (
								<tr
									key={member.userId ?? member.email ?? member.redeemedAt}
									className="border-border border-t"
								>
									<td className="px-3 py-2">
										<div className="break-all font-medium">
											{member.name || member.email || 'Unknown learner'}
										</div>
										{member.name && member.email ? (
											<div className="text-muted-foreground break-all">
												{member.email}
											</div>
										) : null}
										{member.signedIn ? null : (
											<div className="text-muted-foreground">
												Hasn't signed in
											</div>
										)}
									</td>
									<td className="px-3 py-2">{day(member.redeemedAt)}</td>
									<td className="px-3 py-2">{day(member.lastActiveAt)}</td>
									<td className="px-3 py-2 text-right">
										{number.format(member.lessonsCompleted)}
									</td>
									<td className="px-3 py-2 text-right">
										{member.workshops.started} of {member.workshops.total}
									</td>
									<td className="px-3 py-2 text-right">
										{member.workshops.completed} of {member.workshops.total}
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>
			{unredeemedSeats === null ? null : (
				<p className={TYPE.metaMark}>
					{unredeemedSeats === 1
						? '1 seat not redeemed yet.'
						: `${number.format(unredeemedSeats)} seats not redeemed yet.`}
				</p>
			)}
		</div>
	)
}
