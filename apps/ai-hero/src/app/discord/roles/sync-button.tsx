'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { syncDiscordRoles } from './actions'

export function SyncRolesButton({ needsSync }: { needsSync: boolean }) {
	const [state, setState] = React.useState<
		'idle' | 'syncing' | 'success' | 'error'
	>('idle')
	const [message, setMessage] = React.useState('')
	const router = useRouter()

	const handleSync = async () => {
		setState('syncing')
		try {
			const result = await syncDiscordRoles()
			if (result.success) {
				if (result.synced > 0) {
					setMessage(
						`${result.synced} role${result.synced > 1 ? 's' : ''} synced`,
					)
					setState('success')
				} else {
					setMessage('All roles already assigned')
					setState('success')
				}
				router.refresh()
			} else {
				setMessage(result.error ?? 'Something went wrong')
				setState('error')
			}
		} catch {
			setMessage('Failed to sync roles')
			setState('error')
		}
	}

	return (
		<div className="flex flex-col items-center gap-3">
			<button
				type="button"
				onClick={handleSync}
				disabled={state === 'syncing' || !needsSync}
				className={`group relative inline-flex items-center gap-2.5 rounded-lg px-6 py-3 text-sm font-semibold tracking-wide transition-all duration-200 disabled:pointer-events-none ${
					needsSync
						? 'bg-[#5865F2] text-white shadow-lg shadow-[#5865F2]/25 hover:bg-[#4752C4] hover:shadow-[#5865F2]/40 active:scale-[0.98]'
						: 'bg-secondary text-muted-foreground hover:bg-secondary/80'
				} `}
			>
				{state === 'syncing' ? (
					<>
						<svg
							className="size-4 animate-spin"
							viewBox="0 0 24 24"
							fill="none"
						>
							<circle
								className="opacity-25"
								cx="12"
								cy="12"
								r="10"
								stroke="currentColor"
								strokeWidth="3"
							/>
							<path
								className="opacity-75"
								fill="currentColor"
								d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
							/>
						</svg>
						Syncing...
					</>
				) : needsSync ? (
					<>
						<svg className="size-4" viewBox="0 0 20 20" fill="currentColor">
							<path
								fillRule="evenodd"
								d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.598a.75.75 0 00-.75.75v3.634a.75.75 0 001.5 0v-2.033l.312.312a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm-5.624-7.849a7 7 0 00-11.712 3.139.75.75 0 001.449.389 5.5 5.5 0 019.201-2.466l.312.311H6.505a.75.75 0 000 1.5h3.634a.75.75 0 00.75-.75V2.064a.75.75 0 00-1.5 0v2.033l-.312-.312z"
								clipRule="evenodd"
								transform="translate(2, 2)"
							/>
						</svg>
						Sync My Roles
					</>
				) : (
					<>
						<svg className="size-4" viewBox="0 0 20 20" fill="currentColor">
							<path
								fillRule="evenodd"
								d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
								clipRule="evenodd"
							/>
						</svg>
						All Roles Synced
					</>
				)}
			</button>

			{message && (
				<p
					className={`text-xs ${
						state === 'error' ? 'text-destructive' : 'text-muted-foreground'
					}`}
				>
					{message}
				</p>
			)}
		</div>
	)
}
