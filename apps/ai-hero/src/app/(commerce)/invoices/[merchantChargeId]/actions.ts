'use server'

import { revalidatePath } from 'next/cache'
import {
	describeInvoiceSettingsForLog,
	drizzleInvoiceSettingsDataSource,
	saveInvoiceSettingsForViewer,
	type InvoiceSettingsInput,
	type SaveInvoiceSettingsResult,
} from '@/lib/invoice-settings'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

/**
 * Save server-persisted invoice details for the invoice identified by its
 * merchant charge id. Authorization (purchase owner or team manager) and
 * readback verification live in the lib. Logs carry field presence only,
 * never billing values.
 */
export async function saveInvoiceSettingsAction(
	merchantChargeId: string,
	input: InvoiceSettingsInput,
): Promise<SaveInvoiceSettingsResult> {
	const { session } = await getServerAuthSession()
	const viewerUserId = session?.user?.id

	const result = await saveInvoiceSettingsForViewer(
		{ merchantChargeId, viewerUserId, input },
		drizzleInvoiceSettingsDataSource,
	)

	if (result.state === 'saved') {
		await log.info('invoice-settings.saved', {
			...describeInvoiceSettingsForLog(result.settings),
		})
		revalidatePath(`/invoices/${merchantChargeId}`)
	} else {
		// The merchant charge id is not a billing value; it already appears in
		// the route path. Never log field contents here.
		await log.warn('invoice-settings.save-rejected', {
			merchantChargeId,
			state: result.state,
		})
	}

	return result
}
