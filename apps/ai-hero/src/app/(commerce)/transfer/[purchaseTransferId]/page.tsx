import { revalidatePath, updateTag } from 'next/cache'
import { notFound, redirect } from 'next/navigation'
import { courseBuilderAdapter } from '@/db'
import { INCOMING_TRANSFERS_TAG } from '@/lib/incoming-transfers'
import { purchaseArtwork } from '@/lib/purchase-artwork'
import { acceptPurchaseTransfer } from '@/purchase-transfer/purchase-transfer-actions'
import { isTransferExpired } from '@/purchase-transfer/transfer-lifecycle'
import { getServerAuthSession } from '@/server/auth'

import { welcomeStart } from '../../welcome/welcome-start'
import {
	TransferScreen,
	type TransferView,
} from './_components/transfer-screen'

/** States a transfer link can be opened in; AVAILABLE has not been sent yet. */
const SENT = ['INITIATED', 'VERIFIED', 'COMPLETED', 'CANCELED', 'EXPIRED']

const PurchaseTransferPage = async (props: {
	params: Promise<{ purchaseTransferId: string }>
}) => {
	const { purchaseTransferId: id } = await props.params
	const [{ session }, transfer] = await Promise.all([
		getServerAuthSession(),
		courseBuilderAdapter.getPurchaseUserTransferById({ id }),
	])
	if (!transfer?.purchase || !SENT.includes(transfer.transferState)) notFound()

	const productId = transfer.purchase.productId
	const product = await courseBuilderAdapter.getProduct(productId)
	const viewer = session?.user
	const viewerIsRecipient = Boolean(
		viewer?.id && viewer.id === transfer.targetUserId,
	)

	let view: TransferView
	if (transfer.transferState === 'COMPLETED') {
		view = {
			kind: 'accepted',
			viewerIsRecipient,
			start: viewerIsRecipient
				? welcomeStart({
						product,
						productResources:
							await courseBuilderAdapter.getProductResources(productId),
						ownsASeat: true,
					})
				: null,
		}
	} else if (transfer.transferState === 'CANCELED') {
		view = { kind: 'canceled' }
	} else if (
		transfer.transferState === 'EXPIRED' ||
		isTransferExpired(transfer)
	) {
		view = { kind: 'expired' }
	} else if (viewerIsRecipient) {
		// VERIFIED is a claim whose completion was interrupted; accepting again
		// resumes it, so the recipient sees the same button.
		view = { kind: 'accept' }
	} else {
		view = { kind: 'sign-in', viewerEmail: viewer?.email ?? null }
	}

	async function accept() {
		'use server'
		await acceptPurchaseTransfer({ purchaseUserTransferId: id })
		updateTag(INCOMING_TRANSFERS_TAG)
		revalidatePath(`/transfer/${id}`)
		redirect(`/transfer/${id}`)
	}

	return (
		<TransferScreen
			view={view}
			transferId={id}
			productName={product?.name ?? 'your purchase'}
			artwork={purchaseArtwork(product)}
			senderName={
				transfer.sourceUser?.name || transfer.sourceUser?.email || 'Someone'
			}
			senderEmail={transfer.sourceUser?.email}
			recipientEmail={transfer.targetUser?.email ?? ''}
			accept={accept}
		/>
	)
}

export default PurchaseTransferPage
