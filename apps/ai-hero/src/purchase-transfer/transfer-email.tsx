import process from 'process'
import PurchaseTransferEmail from '@coursebuilder/email-templates/emails/purchase-transfer'
import { render } from '@react-email/render'
import type { Theme } from '@auth/core/types'

type TransferEmailParams = Record<'url' | 'host' | 'email', string> & {
	expires?: Date
}

export async function transferEmailHtml(
	{ url, host, email }: TransferEmailParams,
	theme?: Theme,
) {
	return render(
		PurchaseTransferEmail(
			{
				url,
				host,
				email,
				siteName:
					process.env.NEXT_PUBLIC_PRODUCT_NAME ||
					process.env.NEXT_PUBLIC_SITE_TITLE ||
					'',
				previewText: 'Claim your seat.',
			},
			theme,
		),
	)
}

export async function transferEmailText(
	{ url, host, email }: TransferEmailParams,
	theme?: Theme,
) {
	return render(
		PurchaseTransferEmail(
			{
				url,
				host,
				email,
				siteName:
					process.env.NEXT_PUBLIC_PRODUCT_NAME ||
					process.env.NEXT_PUBLIC_SITE_TITLE ||
					'',
				previewText:
					process.env.NEXT_PUBLIC_PRODUCT_NAME ||
					process.env.NEXT_PUBLIC_SITE_TITLE ||
					'login link',
			},
			theme,
		),
		{ plainText: true },
	)
}
