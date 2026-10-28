'use server'

import { headers } from 'next/headers'
import { scheduleProductEvents } from '@/lib/subscriber-marketing/product-events-live'
import {
	confirmTeamInvoice,
	startTeamInvoice,
} from '@/lib/team-invoice/create-team-invoice'
import type {
	TeamInvoiceFormInput,
	TeamInvoiceResult,
} from '@/lib/team-invoice/schema'
import { teamInvoiceServerDeps } from '@/lib/team-invoice/team-invoice-server'
import { log } from '@/server/logger'

/**
 * "Pay by invoice" on a team page. The client sends billing details and a
 * seat count; the server checks them and emails the billing address a link
 * to confirm. Nothing is invoiced yet.
 */
export async function requestTeamInvoice(
	input: TeamInvoiceFormInput & { location?: string },
): Promise<TeamInvoiceResult> {
	try {
		const headersList = await headers()
		const ip =
			headersList.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
		return await startTeamInvoice(input, { ip }, teamInvoiceServerDeps())
	} catch (error) {
		await log.error('team_invoice.action_error', {
			message: error instanceof Error ? error.message : String(error),
		})
		return { kind: 'error' }
	}
}

/**
 * The billing email's owner pressed "Send the invoice" on the confirm page.
 * A POST, so a mail scanner that follows the link creates nothing.
 */
export async function confirmTeamInvoiceAction(
	token: string,
): Promise<TeamInvoiceResult> {
	try {
		const result = await confirmTeamInvoice(String(token ?? ''), teamInvoiceServerDeps())
		if (result.kind === 'sent') {
			scheduleProductEvents(async () => result.email, [{
				_tag: 'TeamIntent', intent: 'invoice', sourceId: 'team-invoice', at: Date.now(),
			}])
		}
		return result
	} catch (error) {
		await log.error('team_invoice.confirm_error', {
			message: error instanceof Error ? error.message : String(error),
		})
		return { kind: 'error' }
	}
}
