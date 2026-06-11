import * as React from 'react'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Icon } from '@/components/brand/icons'
import LayoutClient from '@/components/layout-client'
import { getServerAuthSession } from '@/server/auth'

import { getDiscordRoleState, type RoleStatus } from './actions'
import { SyncRolesButton } from './sync-button'

export const metadata: Metadata = {
	title: 'Discord Roles | AI Hero',
	description: 'Manage your Discord roles for AI Hero courses',
}

function RoleCard({ role }: { role: RoleStatus }) {
	return (
		<div
			className={`group relative flex items-center justify-between rounded-lg border px-4 py-3 transition-colors duration-150 ${
				role.assigned
					? 'border-border/60 bg-card'
					: 'border-[#5865F2]/30 bg-[#5865F2]/5'
			} `}
		>
			<div className="flex items-center gap-3">
				<div
					className="ring-offset-background size-3 rounded-full ring-2 ring-offset-2"
					style={{ backgroundColor: role.roleColor }}
				/>
				<div>
					<span className="text-sm font-medium">{role.roleName}</span>
					<span className="text-muted-foreground ml-2 text-xs">
						via {role.source}
					</span>
				</div>
			</div>

			{role.assigned ? (
				<span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-500">
					<svg className="size-3" viewBox="0 0 20 20" fill="currentColor">
						<path
							fillRule="evenodd"
							d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
							clipRule="evenodd"
						/>
					</svg>
					Active
				</span>
			) : (
				<span className="inline-flex items-center gap-1.5 rounded-full bg-[#5865F2]/10 px-2.5 py-0.5 text-xs font-medium text-[#5865F2]">
					<svg className="size-3" viewBox="0 0 20 20" fill="currentColor">
						<path d="M10 3a.75.75 0 01.55.24l3.25 3.5a.75.75 0 11-1.1 1.02L10 4.852 7.3 7.76a.75.75 0 01-1.1-1.02l3.25-3.5A.75.75 0 0110 3zm-3.76 9.2a.75.75 0 011.06.04l2.7 2.908 2.7-2.908a.75.75 0 111.1 1.02l-3.25 3.5a.75.75 0 01-1.1 0l-3.25-3.5a.75.75 0 01.04-1.06z" />
					</svg>
					Needs sync
				</span>
			)}
		</div>
	)
}

export default async function DiscordRolesPage() {
	const { session } = await getServerAuthSession()

	if (!session?.user) {
		redirect(
			'/login?callbackUrl=/discord/roles&message=Log+in+to+manage+Discord+roles',
		)
	}

	const state = await getDiscordRoleState()

	if (!state) {
		redirect('/login?callbackUrl=/discord/roles')
	}

	// Not connected to Discord: send them to connect
	if (!state.connected) {
		redirect('/discord?callbackUrl=/discord/roles')
	}

	const { roles, needsSync, discordUsername, allAssigned } = state

	return (
		<LayoutClient withContainer>
			<main className="mx-auto flex min-h-[calc(100vh-var(--nav-height))] w-full max-w-lg flex-col items-center justify-center gap-8 px-5 py-16">
				{/* Header */}
				<div className="flex flex-col items-center gap-4 text-center">
					<div className="flex size-14 items-center justify-center rounded-2xl bg-[#5865F2]">
						<Icon name="Discord" size="24" className="text-white" />
					</div>
					<div>
						<h1 className="text-2xl font-bold tracking-tight">Discord Roles</h1>
						{discordUsername && (
							<p className="text-muted-foreground mt-1 text-sm">
								Connected as{' '}
								<span className="text-foreground font-medium">
									@{discordUsername}
								</span>
							</p>
						)}
					</div>
				</div>

				{/* Role List */}
				{roles.length > 0 ? (
					<div className="w-full space-y-2">
						{roles.map((role) => (
							<RoleCard key={role.roleId} role={role} />
						))}
					</div>
				) : (
					<div className="border-border/60 w-full rounded-lg border border-dashed px-6 py-10 text-center">
						<p className="text-muted-foreground text-sm">
							No course roles found. Roles are assigned when you purchase a
							cohort or workshop.
						</p>
					</div>
				)}

				{/* Sync Button */}
				{roles.length > 0 && <SyncRolesButton needsSync={needsSync} />}

				{/* Status Message */}
				{allAssigned && roles.length > 0 && (
					<p className="text-muted-foreground text-center text-xs">
						All your course roles are active in Discord. If you purchase a new
						course, come back here to sync.
					</p>
				)}
			</main>
		</LayoutClient>
	)
}
