'use client'

import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BADGE_NEUTRAL, BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import { TeamMembersTable } from '@/components/team-progress/team-members-table'
import type {
	LearningTeamMembers,
	LearningTeamProgress,
	LearningTeams,
	LearningTeamSummary,
} from '@/lib/analytics/learning-teams'

import {
	FunnelRow,
	shareOf,
	Tiles,
	type LearningProductOption,
} from './learning-progress-panel'

const number = new Intl.NumberFormat('en-US')

export type TeamSortKey =
	| 'purchasedAt'
	| 'bought'
	| 'redeemed'
	| 'active7d'
	| 'averageShare'

const SORT_VALUE: Record<
	TeamSortKey,
	(team: LearningTeamSummary) => number | null
> = {
	purchasedAt: (team) => Date.parse(team.purchasedAt),
	bought: (team) => team.seats.bought,
	redeemed: (team) => team.seats.redeemed,
	active7d: (team) => team.members.active7d,
	averageShare: (team) => team.completion.averageShare,
}

/** Stable sort; teams with no completion share sort last either way. */
export function sortTeams(
	teams: readonly LearningTeamSummary[],
	key: TeamSortKey,
	direction: 'asc' | 'desc',
) {
	const value = SORT_VALUE[key]
	return [...teams].sort((a, b) => {
		const left = value(a)
		const right = value(b)
		if (left === null || right === null)
			return left === right ? 0 : left === null ? 1 : -1
		return direction === 'asc' ? left - right : right - left
	})
}

const percent = (share: number | null) =>
	share === null ? '—' : `${Math.round(share * 100)}%`

const day = (value: string) =>
	new Date(value).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'America/Los_Angeles',
	})

async function readSurface<T>(path: string, signal: AbortSignal) {
	const response = await fetch(`/api/analytics?${path}`, {
		signal,
		cache: 'no-store',
	})
	const body = await response.json()
	if (!response.ok || !body.ok)
		throw new Error(body?.error?.message ?? 'Unavailable')
	return body.data as T
}

const COLUMNS: Array<[key: TeamSortKey, label: string]> = [
	['purchasedAt', 'Purchased'],
	['bought', 'Seats'],
	['redeemed', 'Redeemed'],
	['active7d', 'Active 7d'],
	['averageShare', 'Completion'],
]

function TeamTable({
	teams,
	selected,
	onSelect,
}: {
	teams: LearningTeamSummary[]
	selected: string | null
	onSelect: (teamId: string) => void
}) {
	const [sort, setSort] = useState<{
		key: TeamSortKey
		direction: 'asc' | 'desc'
	}>({ key: 'purchasedAt', direction: 'desc' })
	const sorted = sortTeams(teams, sort.key, sort.direction)
	return (
		<div className="border-border overflow-x-auto border">
			<table className="w-full min-w-[640px] text-left">
				<caption className="sr-only">Team purchases</caption>
				<thead className={`${TYPE.statLabel} bg-muted/40`}>
					<tr>
						<th scope="col" className="px-3 py-2 font-medium">
							Team
						</th>
						{COLUMNS.map(([key, label]) => (
							<th
								key={key}
								scope="col"
								aria-sort={
									sort.key === key
										? sort.direction === 'asc'
											? 'ascending'
											: 'descending'
										: 'none'
								}
								className="px-3 py-2 text-right font-medium"
							>
								<button
									type="button"
									onClick={() =>
										setSort((current) => ({
											key,
											direction:
												current.key === key && current.direction === 'desc'
													? 'asc'
													: 'desc',
										}))
									}
									className="focus-visible:ring-ring uppercase focus-visible:outline-none focus-visible:ring-2"
								>
									{label}
									{sort.key === key
										? sort.direction === 'asc'
											? ' ↑'
											: ' ↓'
										: ''}
								</button>
							</th>
						))}
					</tr>
				</thead>
				<tbody className={`${TYPE.metaSm} tabular-nums`}>
					{sorted.map((team) => (
						<tr
							key={team.teamId}
							className={`border-border border-t ${selected === team.teamId ? 'bg-muted/40' : ''}`}
						>
							<td className="px-3 py-2">
								<button
									type="button"
									onClick={() => onSelect(team.teamId)}
									aria-pressed={selected === team.teamId}
									className="focus-visible:ring-ring text-left underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2"
								>
									<span className="font-medium">{team.product.name}</span>
									<span className="text-muted-foreground block font-mono">
										{team.teamId}
									</span>
								</button>
							</td>
							<td className="px-3 py-2 text-right">{day(team.purchasedAt)}</td>
							<td className="px-3 py-2 text-right">
								{number.format(team.seats.bought)}
							</td>
							<td className="px-3 py-2 text-right">
								{number.format(team.seats.redeemed)}
							</td>
							<td className="px-3 py-2 text-right">
								{shareOf(team.members.active7d, team.members.count).label}
							</td>
							<td className="px-3 py-2 text-right">
								{percent(team.completion.averageShare)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

export function TeamDetailView({
	team,
	members,
}: {
	team: LearningTeamProgress
	members: LearningTeamMembers | null
}) {
	const summary = team.team
	const denominator = team.funnel.denominator.count
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-2">
				<h3 className={TYPE.groupLabel}>Seats and members</h3>
				<Tiles
					tiles={[
						['Seats bought', summary.seats.bought],
						['Redeemed', summary.seats.redeemed],
						['Unredeemed', summary.seats.unredeemed],
						['Members', summary.members.count],
						['Signed in', summary.members.signedIn],
						['Active 7d', summary.members.active7d],
					]}
				/>
				<p className={TYPE.metaMark}>
					Completion: {percent(summary.completion.averageShare)} of{' '}
					{summary.completion.openRequiredLessons} open lessons per member, on
					average. Purchases: {summary.purchaseIds.join(', ')}.
				</p>
			</div>
			<div className="flex flex-col gap-1">
				<h3 className={TYPE.groupLabel}>Workshops</h3>
				<p className={TYPE.metaMark}>
					Every share is out of {number.format(denominator)} team members.
				</p>
				<ol className="mt-2">
					{team.funnel.rows.map((row) => (
						<FunnelRow key={row.id} row={row} denominator={denominator} />
					))}
				</ol>
			</div>
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className={TYPE.groupLabel}>Members</h3>
					<span className={`${TYPE.badge} ${BADGE_OUTLINE}`}>
						PII · admins only
					</span>
					{members?.team.organization?.name ? (
						<span className={TYPE.metaMark}>
							{members.team.organization.name}
						</span>
					) : null}
				</div>
				{members ? (
					<TeamMembersTable
						members={members.members}
						unredeemedSeats={members.team.seats.unredeemed}
						caption="Team members"
					/>
				) : (
					<p className={TYPE.metaMark}>Loading members…</p>
				)}
			</div>
		</div>
	)
}

function TeamDetail({ teamId }: { teamId: string }) {
	const team = useQuery({
		queryKey: ['analytics', 'learning/team', teamId],
		staleTime: 60_000,
		refetchOnWindowFocus: false,
		retry: false,
		queryFn: ({ signal }) =>
			readSurface<LearningTeamProgress>(
				`surface=learning%2Fteam&teamId=${encodeURIComponent(teamId)}`,
				signal,
			),
	})
	// PII: never kept in the query cache after the panel lets go of it.
	const members = useQuery({
		queryKey: ['analytics', 'learning/team-members', teamId],
		gcTime: 0,
		staleTime: 0,
		refetchOnWindowFocus: false,
		retry: false,
		queryFn: ({ signal }) =>
			readSurface<LearningTeamMembers>(
				`surface=learning%2Fteam-members&teamId=${encodeURIComponent(teamId)}`,
				signal,
			),
	})
	if (team.isPending)
		return <p className={TYPE.metaMark}>Loading team progress…</p>
	if (team.isError)
		return (
			<p className={TYPE.metaMark}>Team progress is temporarily unavailable.</p>
		)
	return (
		<>
			<TeamDetailView team={team.data} members={members.data ?? null} />
			{members.isError ? (
				<p className={TYPE.metaMark}>
					Member rows are unavailable: {members.error.message}
				</p>
			) : null}
		</>
	)
}

/** Aggregate team list for support; member rows load per team on demand. */
export function TeamProgressPanel({
	products,
}: {
	products: LearningProductOption[]
}) {
	const [productId, setProductId] = useState('')
	const [selected, setSelected] = useState<string | null>(null)
	const teams = useQuery({
		queryKey: ['analytics', 'learning/teams', productId],
		staleTime: 60_000,
		refetchInterval: 5 * 60_000,
		refetchOnWindowFocus: false,
		retry: false,
		queryFn: ({ signal }) =>
			readSurface<LearningTeams>(
				`surface=learning%2Fteams${productId ? `&productId=${encodeURIComponent(productId)}` : ''}`,
				signal,
			),
	})
	return (
		<section
			aria-label="Team progress"
			className="bg-card text-card-foreground border-border rounded-lg border p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<h2 className={TYPE.cardTitle}>Team progress</h2>
					<span className={`${TYPE.badge} ${BADGE_NEUTRAL}`}>Aggregate</span>
				</div>
				<label className={`${TYPE.meta} flex items-center gap-2`}>
					<span className="text-muted-foreground">Product</span>
					<select
						value={productId}
						onChange={(event) => {
							setProductId(event.target.value)
							setSelected(null)
						}}
						className="border-input bg-card text-foreground focus-visible:ring-ring rounded-[6px] border px-2 py-1 focus-visible:outline-none focus-visible:ring-2"
					>
						<option value="">All products</option>
						{products.map((product) => (
							<option key={product.id} value={product.id}>
								{product.name}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className={`${TYPE.metaMark} mt-2`} aria-live="polite">
				{teams.isPending
					? 'Loading teams…'
					: teams.isError
						? 'Team progress is temporarily unavailable.'
						: `${number.format(teams.data.teams.length)} teams · as of ${new Date(
								teams.data.asOf,
							).toLocaleString('en-US', {
								dateStyle: 'medium',
								timeStyle: 'short',
							})} · refreshes every 5 minutes`}
			</div>
			{teams.data && !teams.isError ? (
				<div className="mt-4 flex flex-col gap-5">
					{teams.data.teams.length === 0 ? (
						<p className={`${TYPE.meta} text-muted-foreground`}>
							No active team purchases.
						</p>
					) : (
						<TeamTable
							teams={teams.data.teams}
							selected={selected}
							onSelect={(teamId) =>
								setSelected((current) => (current === teamId ? null : teamId))
							}
						/>
					)}
					{selected ? <TeamDetail key={selected} teamId={selected} /> : null}
				</div>
			) : null}
		</section>
	)
}
