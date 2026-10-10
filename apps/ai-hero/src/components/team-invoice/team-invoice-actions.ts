'use server'

import { headers } from 'next/headers'
import { createTeamInvoice } from '@/lib/team-invoice/create-team-invoice'
import type {
	TeamInvoiceFormInput,
	TeamInvoiceResult,
} from '@/lib/team-invoice/schema'
import { teamInvoiceServerDeps } from '@/lib/team-invoice/team-invoice-server'
import { log } from '@/server/logger'

/**
 * "Pay by invoice" on a team page. The client sends billing details and a
 * seat count; the server prices, invoices and answers with what to show.
 */
export async function requestTeamInvoice(
	input: TeamInvoiceFormInput & { location?: string },
): Promise<TeamInvoiceResult> {
	try {
		const headersList = await headers()
		const ip =
			headersList.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
		return await createTeamInvoice(input, { ip }, teamInvoiceServerDeps())
	} catch (error) {
		await log.error('team_invoice.action_error', {
			message: error instanceof Error ? error.message : String(error),
		})
		return { kind: 'error' }
	}
}
