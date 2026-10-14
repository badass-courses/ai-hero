import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { purchaseUserTransfer } from '@/db/schema'
import { isTransferAccepted } from '@/purchase-transfer/transfer-lifecycle'
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'

export type IncomingTransfer = { id: string; productName: string | null }

/** Expire with `updateTag` when a recipient accepts, so the reminder stops. */
export const INCOMING_TRANSFERS_TAG = 'incoming-transfers'

/**
 * Every transfer still waiting for its recipient, as one short shared list.
 *
 * The reminder asks on every signed-in page view, and the transfer table has
 * no index on the recipient, so a per-user query would scan all of it each
 * time. The open ones are a few dozen rows: read them once per window and
 * look the user up in memory. A new or canceled transfer shows up within the
 * window, which is fine for a reminder; the transfer page itself is live.
 * An interrupted claim (VERIFIED, purchase not moved) still needs the
 * recipient, at any age; one that already moved the seat does not.
 */
const getOpenTransfers = unstable_cache(
	async () => {
		const open = await db.query.purchaseUserTransfer.findMany({
			where: or(
				and(
					eq(purchaseUserTransfer.transferState, 'INITIATED'),
					or(
						isNull(purchaseUserTransfer.expiresAt),
						gt(purchaseUserTransfer.expiresAt, new Date()),
					),
				),
				eq(purchaseUserTransfer.transferState, 'VERIFIED'),
			),
			orderBy: desc(purchaseUserTransfer.createdAt),
			with: { purchase: { with: { product: true } } },
		})
		return open.flatMap((transfer) =>
			transfer.targetUserId &&
			transfer.purchase &&
			!isTransferAccepted(transfer, transfer.purchase)
				? [
						{
							id: transfer.id,
							targetUserId: transfer.targetUserId,
							productName: transfer.purchase?.product?.name ?? null,
						},
					]
				: [],
		)
	},
	['incoming-transfers-v1'],
	{ revalidate: 300, tags: [INCOMING_TRANSFERS_TAG] },
)

/** The newest seat sent to this user that they have not accepted yet. */
export async function getIncomingTransfer(
	userId: string,
): Promise<IncomingTransfer | null> {
	const transfer = (await getOpenTransfers()).find(
		(open) => open.targetUserId === userId,
	)
	return transfer
		? { id: transfer.id, productName: transfer.productName }
		: null
}
