import type { TeamProgressBlock } from '@/lib/team-progress'

import { TeamMembersTable } from './team-members-table'

/** /team's progress section: managed teams in full, or the viewer's own row. */
export function TeamProgressSection({
	teamProgress,
}: {
	teamProgress: TeamProgressBlock[]
}) {
	if (teamProgress.length === 0) return null
	const managed = teamProgress.some(({ scope }) => scope === 'team')
	return (
		<section className="border-t">
			<div className="px-[18px] py-16 sm:px-11 md:py-24">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Progress
				</p>
				<h2 className="text-3xl font-medium leading-tight tracking-tight sm:text-4xl">
					{managed ? 'Learner progress' : 'Your progress'}
				</h2>
				<p className="text-foreground/70 mt-3 max-w-2xl leading-relaxed">
					{managed
						? 'Lessons and workshops each learner on your team has completed. Only owners and team managers see this.'
						: 'Your own lessons and workshops on your team seat. Team managers see the same row.'}
				</p>
			</div>
			<div className="border-border bg-border grid gap-px border-y">
				{teamProgress.map(({ teamId, scope, data }) => (
					<div
						key={`${scope}-${teamId}`}
						className="bg-background flex flex-col gap-4 px-[18px] py-10 sm:px-11"
					>
						<div>
							<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
								{scope === 'team'
									? data.team.organization?.name || 'Team organization'
									: 'Your seat'}
							</p>
							<h3 className="text-2xl font-semibold leading-tight tracking-tight">
								{data.team.product.name}
							</h3>
							{scope === 'team' ? (
								<p className="text-foreground/70 mt-1 text-sm">
									{data.team.seats.redeemed} of {data.team.seats.bought} seats
									redeemed
								</p>
							) : null}
						</div>
						<TeamMembersTable
							members={data.members}
							unredeemedSeats={
								scope === 'team' ? data.team.seats.unredeemed : null
							}
							caption={
								scope === 'team'
									? `Learner progress for ${data.team.product.name}`
									: `Your progress in ${data.team.product.name}`
							}
						/>
					</div>
				))}
			</div>
		</section>
	)
}
