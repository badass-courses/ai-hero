'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import {
	addTeamSeatsByEmailAction,
	inviteBillingAdminAction,
	type AddTeamSeatsActionState,
	removeBillingAdminAction,
	revokeBillingAdminInvitationAction,
	type TeamManagerActionState,
} from '@/app/(user)/team/actions'
import type { TeamPageData } from '@/app/(user)/team/page'
import { CldImage } from '@/components/cld-image'
import type { TeamCardState } from '@/lib/team-purchases'

import { ClaimedTeamSeats } from '@coursebuilder/commerce-next/team/claimed-team-seats'
import {
	CopyInviteLinkButton,
	InviteLink,
	Root as InviteTeamRoot,
	SeatsAvailable,
} from '@coursebuilder/commerce-next/team/invite-team'
import { Button, Input, Label, Textarea } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

const initialTeamManagerActionState: TeamManagerActionState = {
	status: 'idle',
	message: '',
}

type ManagerAction = (
	previousState: TeamManagerActionState,
	formData: FormData,
) => Promise<TeamManagerActionState>

function ActionMessage({ state }: { state: TeamManagerActionState }) {
	if (state.status === 'idle') return null
	return (
		<p
			aria-live="polite"
			className={cn(
				'text-sm',
				state.status === 'error'
					? 'text-destructive'
					: 'text-muted-foreground',
			)}
		>
			{state.message}
		</p>
	)
}

function InviteManagerForm({ organizationId }: { organizationId: string }) {
	const [state, action, pending] = useActionState(
		inviteBillingAdminAction,
		initialTeamManagerActionState,
	)
	return (
		<form action={action} className="flex flex-col gap-3">
			<input type="hidden" name="organizationId" value={organizationId} />
			<Label htmlFor={`manager-email-${organizationId}`}>Manager email</Label>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					id={`manager-email-${organizationId}`}
					name="email"
					type="email"
					required
					autoComplete="email"
					placeholder="manager@company.com"
					className="rounded-none"
				/>
				<Button type="submit" disabled={pending} className="rounded-none">
					{pending ? 'Sending…' : 'Invite manager'}
				</Button>
			</div>
			<ActionMessage state={state} />
		</form>
	)
}

const initialAddTeamSeatsActionState: AddTeamSeatsActionState = {
	...initialTeamManagerActionState,
	results: [],
}

const SEAT_RESULT_COPY: Record<
	AddTeamSeatsActionState['results'][number]['status'],
	string
> = {
	added: 'Added',
	'added-email-failed': "Added, but the welcome email didn't send. Contact support.",
	'already-had-access': 'Already had access',
	'no-seats-left': 'No seats left',
	invalid: 'Not a valid email address',
	failed: "Couldn't add. Try again or contact support.",
}

function AddSeatsByEmailForm({ purchaseId }: { purchaseId: string }) {
	const [state, action, pending] = useActionState(
		addTeamSeatsByEmailAction,
		initialAddTeamSeatsActionState,
	)
	const fieldId = `seat-emails-${purchaseId}`
	return (
		<form action={action} className="flex flex-col gap-3">
			<input type="hidden" name="purchaseId" value={purchaseId} />
			<Label htmlFor={fieldId}>Add learners by email</Label>
			<p id={`${fieldId}-help`} className="text-foreground/70 text-sm">
				Each seat is for one person and can't be moved to someone else later,
				so check the addresses before adding. Up to 50 at a time.
			</p>
			<Textarea
				id={fieldId}
				name="emails"
				required
				rows={4}
				aria-describedby={`${fieldId}-help`}
				placeholder={'learner@company.com\nanother@company.com'}
				className="rounded-none"
			/>
			<Button type="submit" disabled={pending} className="w-fit rounded-none">
				{pending ? 'Adding…' : 'Add learners'}
			</Button>
			<ActionMessage state={state} />
			{state.results.length > 0 ? (
				<ul className="border-border divide-border divide-y border-y text-sm">
					{state.results.map((result) => (
						<li
							key={result.email}
							className="flex flex-col justify-between gap-1 py-2 sm:flex-row"
						>
							<span className="break-all">{result.email}</span>
							<span
								className={cn(
									'text-muted-foreground',
									(result.status === 'failed' ||
										result.status === 'added-email-failed') &&
										'text-destructive',
								)}
							>
								{SEAT_RESULT_COPY[result.status]}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</form>
	)
}

function ManagerMutationForm({
	action,
	organizationId,
	field,
	value,
	label,
}: {
	action: ManagerAction
	organizationId: string
	field: 'targetMembershipId' | 'invitationId'
	value: string
	label: string
}) {
	const [state, formAction, pending] = useActionState(
		action,
		initialTeamManagerActionState,
	)
	return (
		<form action={formAction} className="flex flex-col items-end gap-2">
			<input type="hidden" name="organizationId" value={organizationId} />
			<input type="hidden" name={field} value={value} />
			<Button
				type="submit"
				variant="outline"
				size="sm"
				disabled={pending}
				className="rounded-none"
			>
				{pending ? 'Working…' : label}
			</Button>
			<ActionMessage state={state} />
		</form>
	)
}

function ManagersSection({ organizations }: Pick<TeamPageData, 'organizations'>) {
	return (
		<section className="border-b">
			<div className="px-[18px] py-16 sm:px-11 md:py-24">
				<div className="mb-8 max-w-2xl">
					<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
						Access
					</p>
					<h2 className="text-3xl font-medium leading-tight tracking-tight sm:text-4xl">
						Team managers
					</h2>
					<p className="text-foreground/70 mt-3 leading-relaxed">
						Managers can invite learners, see seat usage, and view team
						invoices. This role does not use a seat.
					</p>
				</div>
			</div>
			<div className="border-border bg-border grid gap-px border-y">
				{organizations.map((organization) => (
					<div key={organization.id} className="bg-background px-[18px] py-10 sm:px-11">
						<div className="mb-6">
							<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
								Organization
							</p>
							<h3 className="text-2xl font-semibold leading-tight tracking-tight">
								{organization.name}
							</h3>
						</div>

						<ul className="border-border divide-border mb-8 divide-y border-y">
							{organization.managers.map((manager) => (
								<li
									key={manager.membershipId}
									className="flex flex-col justify-between gap-4 py-4 sm:flex-row sm:items-center"
								>
									<div>
										<p className="font-medium">{manager.name || manager.email}</p>
										<p className="text-muted-foreground text-sm">
											{manager.email} · {manager.role === 'owner' ? 'Owner' : 'Manager'}
										</p>
									</div>
									{manager.role === 'billing_admin' ? (
										<ManagerMutationForm
											action={removeBillingAdminAction}
											organizationId={organization.id}
											field="targetMembershipId"
											value={manager.membershipId}
											label="Remove manager"
										/>
									) : (
										<span className="text-muted-foreground font-mono text-[11px] uppercase tracking-wider">
											Protected
										</span>
									)}
								</li>
							))}
							{organization.pendingInvitations.map((invitation) => (
								<li
									key={invitation.id}
									className="flex flex-col justify-between gap-4 py-4 sm:flex-row sm:items-center"
								>
									<div>
										<p className="font-medium">{invitation.email}</p>
										<p className="text-muted-foreground text-sm">Pending invitation</p>
									</div>
									<ManagerMutationForm
										action={revokeBillingAdminInvitationAction}
										organizationId={organization.id}
										field="invitationId"
										value={invitation.id}
										label="Revoke invitation"
									/>
								</li>
							))}
						</ul>
						<InviteManagerForm organizationId={organization.id} />
					</div>
				))}
			</div>
		</section>
	)
}

const TEAM_CARD_STATE_COPY: Record<Exclude<TeamCardState, 'active'>, string> =
	{
		refunded:
			'Refunded. This purchase was refunded, so its seats are no longer available.',
		'setting-up':
			"Your team is being set up. Contact support if this doesn't change.",
		'managed-by-admin':
			"Managed by your organization's team admin. Ask them for seats or invoices.",
		'coupon-inactive':
			'Seat invitations are turned off for this purchase. Contact support if that is a surprise.',
		unavailable: 'This purchase is not available for team seats.',
	}

function TeamPurchases({
	bulkPurchases,
	organizations,
	viewer,
}: Pick<TeamPageData, 'bulkPurchases' | 'organizations' | 'viewer'>) {
	return (
		<section>
			<div className="px-[18px] py-16 sm:px-11 md:py-24">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Seats and invoices
				</p>
				<h2 className="text-3xl font-medium leading-tight tracking-tight sm:text-4xl">
					Team purchases
				</h2>
			</div>
			{bulkPurchases.length === 0 ? (
				<div className="bg-stripes border-y px-[18px] py-16 text-center sm:px-11">
					<p className="bg-background inline-block px-4 py-2 font-mono text-[11px] uppercase tracking-wider">
						No active team purchases
					</p>
				</div>
			) : (
				<div className="border-border bg-border grid gap-px border-y md:grid-cols-2">
					{bulkPurchases.map(({ purchase, bulkCoupon, state }) => {
						const organizationName = organizations.find(
							({ id }) => id === purchase.organizationId,
						)?.name
						const redemptionsLeft = Boolean(
							bulkCoupon &&
								bulkCoupon.maxUses > bulkCoupon.usedCount &&
								bulkCoupon.status === 1,
						)
						const purchaseWithCoupon = { ...purchase, bulkCoupon }
						return (
							<article key={purchase.id} className="bg-background flex flex-col gap-6 px-[18px] py-10 sm:px-11">
								<div>
									<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
										{organizationName || 'Team organization'}
									</p>
								</div>
								<div className="flex items-center gap-4">
									{purchase.product?.fields.image?.url ? (
										<CldImage
											width={80}
											height={80}
											src={purchase.product.fields.image.url}
											alt=""
										/>
									) : null}
									<h3 className="text-2xl font-semibold leading-tight tracking-tight">
										{purchase.product?.name || 'AI Hero team access'}
									</h3>
								</div>

								{state === 'active' ? (
									<>
										<InviteTeamRoot
											purchase={purchaseWithCoupon}
											existingPurchase={null}
											userEmail={viewer?.email}
											disabled={!redemptionsLeft}
											className="flex flex-col gap-3"
										>
											<SeatsAvailable className="[&_span]:font-semibold" />
											<p className="text-foreground/70 text-sm">
												Share this link with learners who should claim a seat.
											</p>
											<div className="flex items-center gap-2">
												<InviteLink className="rounded-none" />
												<CopyInviteLinkButton className="rounded-none" />
											</div>
										</InviteTeamRoot>

										{organizationName && redemptionsLeft ? (
											<AddSeatsByEmailForm purchaseId={purchase.id} />
										) : null}

										<ClaimedTeamSeats
											purchase={purchase}
											bulkCoupon={bulkCoupon}
										/>
									</>
								) : (
									<p
										className="text-foreground/70 text-sm"
										data-team-card-state={state}
									>
										{TEAM_CARD_STATE_COPY[state]}
									</p>
								)}

								{purchase.merchantChargeId ? (
									<Link
										href={`/invoices/${purchase.merchantChargeId}`}
										className="focus-visible:ring-ring inline-flex w-fit text-sm font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-offset-2"
									>
										View invoice or receipt
									</Link>
								) : null}
							</article>
						)
					})}
					{bulkPurchases.length % 2 === 1 ? (
						<div aria-hidden className="bg-background hidden md:block" />
					) : null}
				</div>
			)}
		</section>
	)
}

export function TeamPageTemplate(data: TeamPageData) {
	if (data.view === 'anonymous') {
		return (
			<section className="border-b">
				<div className="px-[18px] py-20 sm:px-11 md:py-24">
					<h1 className="text-4xl font-normal leading-tight tracking-tight sm:text-5xl">
						Team access
					</h1>
					<p className="text-foreground/70 mt-4 max-w-2xl text-lg leading-relaxed">
						Sign in to view your team access or manage team seats.
					</p>
					<Button asChild className="mt-6 rounded-none">
						<Link href="/login?callbackUrl=%2Fteam">Sign in</Link>
					</Button>
				</div>
			</section>
		)
	}

	if (data.view === 'member') {
		return (
			<section className="border-b">
				<div className="px-[18px] py-20 sm:px-11 md:py-24">
					<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
						Member access
					</p>
					<h1 className="text-4xl font-normal leading-tight tracking-tight sm:text-5xl">
						Your team access
					</h1>
					<p className="text-foreground/70 mt-4 max-w-2xl text-lg leading-relaxed">
						Your account can use seats assigned to it. Team seat management and invoices are available only to owners and team managers.
					</p>
				</div>
				{data.bulkPurchases.length > 0 ? (
					<TeamPurchases
						bulkPurchases={data.bulkPurchases}
						organizations={data.organizations}
						viewer={data.viewer}
					/>
				) : null}
			</section>
		)
	}

	return (
		<div className="w-full">
			<section className="border-b">
				<div className="px-[18px] py-20 sm:px-11 md:py-24">
					<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
						Organization billing
					</p>
					<h1 className="text-5xl font-normal leading-[1.05] tracking-tight lg:text-6xl">
						Manage your team
					</h1>
					<p className="text-foreground/70 mt-4 max-w-2xl text-lg leading-relaxed">
						Invite learners, track claimed seats, and give trusted teammates manager access without sharing an account.
					</p>
				</div>
			</section>
			<ManagersSection organizations={data.organizations} />
			<TeamPurchases
				bulkPurchases={data.bulkPurchases}
				organizations={data.organizations}
				viewer={data.viewer}
			/>
		</div>
	)
}
