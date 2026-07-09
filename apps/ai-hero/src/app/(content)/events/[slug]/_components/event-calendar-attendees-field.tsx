'use client'

import * as React from 'react'
import {
	addEventCalendarAttendee,
	listEventCalendarAttendees,
	removeEventCalendarAttendee,
} from '@/lib/cms/calendar-attendees-actions'
import type { CalendarAttendee } from '@/lib/cms/calendar-attendees-service'
import { useConfirm } from '@/hooks/use-confirm'

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from '@coursebuilder/ui'
import { Field, fieldControlClassName } from '@coursebuilder/ui/cms'
import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * Live guest-list editor for the cms event editor's Calendar tab — the
 * `{ kind: 'custom' }` field mounted in `EditEventClient`. Lists the event's
 * current Google Calendar attendees (collapsed into an accordion, closed by
 * default) and lets an admin add/remove arbitrary people by email.
 *
 * Unlike the form-backed custom fields (e.g. `CmsGuestLinksField`), this reflects
 * LIVE Google Calendar state via session-driven server actions
 * (`calendar-attendees-actions.ts`) — nothing is written to the form. Adding
 * emails the guest a Google Calendar invite; removing (behind a confirm) emails
 * them a cancellation.
 */
export function EventCalendarAttendeesField({
	slugOrId,
}: {
	slugOrId: string
}) {
	const [attendees, setAttendees] = React.useState<CalendarAttendee[]>([])
	const [status, setStatus] = React.useState<
		'ready' | 'sync-pending' | 'event-missing'
	>('ready')
	const [loading, setLoading] = React.useState(true)
	const [loadError, setLoadError] = React.useState<string | null>(null)
	const [email, setEmail] = React.useState('')
	const [actionError, setActionError] = React.useState<string | null>(null)
	const [copied, setCopied] = React.useState(false)
	const [isPending, startTransition] = React.useTransition()
	const [ConfirmDialog, confirm] = useConfirm()

	const refresh = React.useCallback(async () => {
		setLoadError(null)
		try {
			const result = await listEventCalendarAttendees(slugOrId)
			setStatus(result.kind)
			setAttendees(result.kind === 'ready' ? result.attendees : [])
		} catch {
			setLoadError('Could not load attendees. Try again.')
		} finally {
			setLoading(false)
		}
	}, [slugOrId])

	React.useEffect(() => {
		void refresh()
	}, [refresh])

	const handleCopy = async () => {
		// Comma-separated is the RFC 5322 address separator — pastes into the To/Cc
		// field of Gmail, Apple Mail, and modern Outlook.
		const list = attendees.map((a) => a.email).join(', ')
		try {
			await navigator.clipboard.writeText(list)
			setCopied(true)
			window.setTimeout(() => setCopied(false), 2000)
		} catch {
			setActionError('Could not copy to clipboard.')
		}
	}

	const handleAdd = (event: React.FormEvent) => {
		event.preventDefault()
		const trimmed = email.trim()
		if (!trimmed || isPending) return
		setActionError(null)
		startTransition(async () => {
			// A non-CalendarError (e.g. an expired session) rethrown from the action
			// would otherwise crash the whole editor into the route error boundary —
			// catch it so the user stays on the page.
			try {
				const result = await addEventCalendarAttendee(slugOrId, trimmed)
				if (!result.ok) {
					setActionError(result.error)
					return
				}
				setEmail('')
				await refresh()
			} catch {
				setActionError('Something went wrong. Please try again.')
			}
		})
	}

	const handleRemove = async (target: string) => {
		if (isPending) return
		const confirmed = await confirm({
			title: 'Remove attendee?',
			description: `${target} will be removed from the event and emailed a Google Calendar cancellation.`,
			confirmText: 'Remove',
			variant: 'destructive',
		})
		if (!confirmed) return
		setActionError(null)
		startTransition(async () => {
			try {
				const result = await removeEventCalendarAttendee(slugOrId, target)
				if (!result.ok) {
					setActionError(result.error)
					return
				}
				await refresh()
			} catch {
				setActionError('Something went wrong. Please try again.')
			}
		})
	}

	return (
		<Field
			label="Calendar attendees"
			// Hide the hint until attendees have loaded — no need for the explainer
			// while the panel is still fetching.
			hint={
				loading
					? undefined
					: "People on the event's Google Calendar guest list. Adding emails them a calendar invite; removing emails a cancellation."
			}
		>
			<ConfirmDialog />
			{loading ? (
				<p className="text-muted-foreground text-[12px]">Loading attendees…</p>
			) : loadError ? (
				<p className="text-destructive text-[12px]">{loadError}</p>
			) : status === 'sync-pending' ? (
				<p className="text-muted-foreground text-[12px]">
					This event hasn't been synced to Google Calendar yet. Save the event
					and, once it has a calendar entry, attendees can be managed here.
				</p>
			) : status === 'event-missing' ? (
				<p className="text-muted-foreground text-[12px]">
					The Google Calendar event no longer exists (it may have been deleted).
					Re-save the event to recreate it.
				</p>
			) : (
				<div className="flex flex-col gap-1.5">
					{attendees.length === 0 ? (
						<p className="text-muted-foreground text-[12px]">
							No attendees yet.
						</p>
					) : (
						<Accordion type="single" collapsible>
							<AccordionItem value="attendees">
								<AccordionTrigger>
									{attendees.length}{' '}
									{attendees.length === 1 ? 'attendee' : 'attendees'}
								</AccordionTrigger>
								<AccordionContent className="flex flex-col gap-1.5">
									<div className="flex justify-end">
										<button
											type="button"
											onClick={handleCopy}
											className="text-muted-foreground hover:text-foreground text-[11px] font-medium hover:underline"
										>
											{copied ? 'Copied ✓' : 'Copy emails'}
										</button>
									</div>
									{attendees.map((attendee) => (
										<div
											key={attendee.email}
											className="border-border flex items-center justify-between gap-1.5 rounded-md border px-2.5 py-1.5"
										>
											<span className="min-w-0 truncate text-[12px]">
												<span className="font-mono">{attendee.email}</span>
												{attendee.displayName ? (
													<span className="text-muted-foreground">
														{' '}
														· {attendee.displayName}
													</span>
												) : null}
												{attendee.responseStatus &&
												attendee.responseStatus !== 'needsAction' ? (
													<span className="text-muted-foreground">
														{' '}
														· {attendee.responseStatus}
													</span>
												) : null}
											</span>
											<button
												type="button"
												aria-label={`Remove ${attendee.email}`}
												onClick={() => void handleRemove(attendee.email)}
												disabled={isPending}
												className="text-muted-foreground hover:text-foreground shrink-0 text-[11px] font-medium hover:underline disabled:opacity-50"
											>
												Remove
											</button>
										</div>
									))}
								</AccordionContent>
							</AccordionItem>
						</Accordion>
					)}

					<form onSubmit={handleAdd} className="flex items-center gap-1.5">
						<input
							type="email"
							placeholder="person@example.com"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							className={cn(fieldControlClassName, 'flex-1 font-mono')}
						/>
						<button
							type="submit"
							disabled={isPending || !email.trim()}
							className="text-muted-foreground border-border hover:text-foreground hover:border-ring shrink-0 rounded-md border border-dashed px-2.5 py-1.5 text-center text-[12px] transition-colors disabled:opacity-50"
						>
							+ Add
						</button>
					</form>

					{actionError ? (
						<p className="text-destructive text-[12px]">{actionError}</p>
					) : null}
				</div>
			)}
		</Field>
	)
}
