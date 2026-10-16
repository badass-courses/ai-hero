'use server'

import { headers } from 'next/headers'
import { courseBuilderAdapter } from '@/db'
import {
	ACCEPTANCE_STATE_OF_TRANSFER,
	transferPageView,
} from '@/lib/transfer-page-view'
import {
	isTransferAccepted,
	isTransferExpired,
} from '@/purchase-transfer/transfer-lifecycle'
import { signIn } from '@/server/auth'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { Ratelimit } from '@upstash/ratelimit'

/**
 * The auth email path has no limiter of its own (not in the provider, the
 * proxy or the route), and this action is public, so it carries one: a few
 * links per transfer and a few more per address. If the limiter is down the
 * action still sends, so a recipient is not locked out by an outage.
 */
async function withinLimit(transferId: string) {
	try {
		const ip = (await headers()).get('x-forwarded-for') ?? 'unknown'
		const perTransfer = new Ratelimit({
			redis,
			limiter: Ratelimit.slidingWindow(3, '10 m'),
		})
		const perIp = new Ratelimit({
			redis,
			limiter: Ratelimit.slidingWindow(10, '10 m'),
		})
		const [a, b] = await Promise.all([
			perTransfer.limit(`transfer_login_${transferId}`),
			perIp.limit(`transfer_login_ip_${ip}`),
		])
		return a.success && b.success
	} catch (error) {
		await log.error('transfer.login.ratelimit_unavailable', {
			error: error instanceof Error ? error.message : String(error),
		})
		return true
	}
}

/**
 * Emails a login link for the transfer's recipient that comes back to the
 * transfer page. The address is resolved here, on the server, so the page
 * never ships the full recipient email to the browser. Only a transfer the page
 * itself would show as waiting for sign-in can ask for a link.
 */
export async function sendTransferLogin(transferId: string) {
	const transfer = await courseBuilderAdapter.getPurchaseUserTransferById({
		id: transferId,
	})
	const email = transfer?.targetUser?.email
	if (!transfer?.purchase || !email) return { sent: false as const }
	// AVAILABLE has not been sent; the page 404s on it, so the action refuses.
	if (ACCEPTANCE_STATE_OF_TRANSFER[transfer.transferState] !== 'pending')
		return { sent: false as const }

	const { kind } = transferPageView({
		transferState: transfer.transferState,
		purchaseMoved: isTransferAccepted(transfer, transfer.purchase),
		clockExpired: isTransferExpired(transfer),
		viewer: 'signed-out',
		linkUsed: false,
	})
	if (kind !== 'sign-in') return { sent: false as const }
	if (!(await withinLimit(transfer.id))) return { sent: false as const }

	await signIn('postmark', {
		email,
		redirectTo: `/transfer/${transfer.id}`,
		redirect: false,
	})
	return { sent: true as const }
}
