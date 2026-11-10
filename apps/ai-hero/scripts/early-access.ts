/** Signed operator workflow. SUPPORT_WEBHOOK_SECRET comes from secret injection.
 * pnpm exec tsx scripts/early-access.ts grant in_… [--apply]
 * pnpm exec tsx scripts/early-access.ts report
 * pnpm exec tsx scripts/early-access.ts revoke in_… [--apply]
 * AIH_EARLY_ACCESS_ORIGIN can select a local test server, never a preview.
 * All mutations dry-run unless --apply. Revocation uses refund entitlement
 * cleanup; it does NOT refund money, void the invoice or send a Stripe refund.
 */
import {
	earlyAccessRequest,
	postEarlyAccess,
} from '../src/lib/team-invoice/early-access-client'

async function main() {
	const input = earlyAccessRequest(process.argv.slice(2))
	const result = await postEarlyAccess(
		process.env.AIH_EARLY_ACCESS_ORIGIN || 'https://www.aihero.dev',
		input,
		process.env.SUPPORT_WEBHOOK_SECRET || '',
	)
	console.log(JSON.stringify(result, null, 2))
	if (!result.ok) process.exitCode = 1
}
main().catch((error: unknown) => {
	// Do not print provider errors: they can include customer data or auth headers.
	console.error(
		error instanceof Error &&
			/^(Use |Unknown arguments|A Stripe invoice|SUPPORT_WEBHOOK_SECRET|Use the AI Hero)/.test(
				error.message,
			)
			? error.message
			: 'Early-access request failed. Inspect the server audit and invoice readback before retrying.',
	)
	process.exitCode = 1
})
