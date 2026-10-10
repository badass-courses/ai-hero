import 'server-only'

import {
	REQUESTABLE_REASONS,
	teamSaleState,
	type TeamSaleProduct,
} from '@/lib/team-invoice/sale-state'
import { isTeamInvoicingEnabled } from '@/lib/team-invoice/team-invoice-server'

import type { ForTeamsInvoice } from './for-teams-page'

/**
 * Which invoice band a team page shows for its product:
 *
 * - on sale, and invoicing is on for the product: "Pay by invoice"
 * - on sale, but invoicing is off (C5 until front-desk prices it): a request
 *   support answers within a working day
 * - not on sale yet: a request, answered when seats open
 * - closed or sold out: no band
 *
 * The page's answer is a hint. The invoice action re-reads the product and
 * decides again.
 */
export function teamInvoiceBand(
	product: TeamSaleProduct,
	options: { now?: Date; purchaseCount?: number; opensLabel?: string | null } = {},
): ForTeamsInvoice | null {
	const state = teamSaleState(product, {
		now: options.now ?? new Date(),
		purchaseCount: options.purchaseCount ?? 0,
	})
	if (state.onSale) {
		return {
			productId: product.id,
			mode: isTeamInvoicingEnabled(product.id) ? 'invoice' : 'request',
		}
	}
	if (!REQUESTABLE_REASONS.has(state.reason)) return null
	return {
		productId: product.id,
		mode: 'request',
		lead: options.opensLabel
			? `Seats open ${options.opensLabel}. Tell us who to bill and how many seats, and we will send the invoice at the team price as soon as they do.`
			: 'Seats are not on sale yet. Tell us who to bill and how many seats, and we will send the invoice at the team price as soon as they are.',
	}
}
