import { revalidatePath, updateTag } from 'next/cache'
import { notFound, redirect } from 'next/navigation'
import { courseBuilderAdapter } from '@/db'
import {
	transferDenialNotice,
	transferPageView,
} from '@/lib/transfer-page-view'
import { INCOMING_TRANSFERS_TAG } from '@/lib/incoming-transfers'
import { purchaseArtwork } from '@/lib/purchase-artwork'
import { acceptPurchaseTransfer } from '@/purchase-transfer/purchase-transfer-actions'
import {
	isTransferAccepted,
	isTransferExpired,
	TransferDenialError,
} from '@/purchase-transfer/transfer-lifecycle'
import { getServerAuthSession } from '@/server/auth'

import { welcomeStart } from '../../welcome/welcome-start'
import { sendTransferLogin } from './actions'
import {
	TransferScreen,
	type TransferView,
} from './_components/transfer-screen'

/** States a transfer link can be opened in; AVAILABLE has not been sent yet. */
const SENT = ['INITIATED', 'VERIFIED', 'COMPLETED', 'CANCELED', 'EXPIRED']

const PurchaseTransferPage = async (props: {
	params: Promise<{ purchaseTransferId: string }>
	searchParams?: Promise<{ link?: string; denied?: string }>
}) => {
	const { purchaseTransferId: id } = await props.params
	const searchParams = await props.searchParams
	const linkUsed = searchParams?.link === 'used'
	const deniedNotice = transferDenialNotice(searchParams?.denied)
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

	const viewerKind = viewerIsRecipient
		? 'recipient'
		: viewer?.id
			? 'other'
			: 'signed-out'
	const { kind, notice } = transferPageView({
		transferState: transfer.transferState,
		purchaseMoved: isTransferAccepted(transfer, transfer.purchase),
		clockExpired: isTransferExpired(transfer),
		viewer: viewerKind,
		linkUsed,
	})

	let view: TransferView
	switch (kind) {
		case 'accepted':
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
			break
		case 'canceled':
			view = { kind: 'canceled' }
			break
		case 'expired':
			view = { kind: 'expired' }
			break
		case 'accept':
			// A VERIFIED claim that has not moved the purchase was interrupted;
			// accepting again resumes it at any age, so it gets the same button.
			view = { kind: 'accept' }
			break
		case 'sign-in':
			view = { kind: 'sign-in', viewerEmail: viewer?.email ?? null }
			break
	}

	async function accept() {
		'use server'
		try {
			await acceptPurchaseTransfer({ purchaseUserTransferId: id })
		} catch (error) {
			// No signed-in user at Accept: show the page's sign-in view (with the
			// "still waiting" notice) rather than a 500.
			if (
				error instanceof TransferDenialError &&
				error.code === 'not_authenticated'
			) {
				redirect(`/transfer/${id}?link=used`)
			}
			// Any other expected denial (a team seat, a wrong recipient, an
			// expired transfer) shows its message on the page instead of a 500.
			if (error instanceof TransferDenialError) {
				redirect(`/transfer/${id}?denied=${encodeURIComponent(error.code)}`)
			}
			throw error
		}
		updateTag(INCOMING_TRANSFERS_TAG)
		revalidatePath(`/transfer/${id}`)
		redirect(`/transfer/${id}`)
	}

	return (
		<TransferScreen
			view={view}
			notice={deniedNotice ?? notice}
			transferId={id}
			productName={product?.name ?? 'your purchase'}
			artwork={purchaseArtwork(product)}
			senderName={
				transfer.sourceUser?.name || transfer.sourceUser?.email || 'Someone'
			}
			senderEmail={transfer.sourceUser?.email}
			recipientEmail={transfer.targetUser?.email ?? ''}
			accept={accept}
			sendLogin={sendTransferLogin}
		/>
	)
}

export default PurchaseTransferPage
