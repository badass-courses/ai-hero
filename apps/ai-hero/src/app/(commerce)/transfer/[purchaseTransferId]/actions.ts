'use server'

import { courseBuilderAdapter } from '@/db'
import { signIn } from '@/server/auth'

/**
 * Emails a login link for the transfer's recipient that comes back to the
 * transfer page. The address is resolved here, on the server, so the page
 * never ships the full recipient email to the browser. Only an open transfer
 * can ask for a link.
 */
export async function sendTransferLogin(transferId: string) {
	const transfer = await courseBuilderAdapter.getPurchaseUserTransferById({
		id: transferId,
	})
	const email = transfer?.targetUser?.email
	if (
		!email ||
		(transfer.transferState !== 'INITIATED' &&
			transfer.transferState !== 'VERIFIED')
	) {
		return { sent: false as const }
	}
	await signIn('postmark', {
		email,
		redirectTo: `/transfer/${transferId}`,
		redirect: false,
	})
	return { sent: true as const }
}
