import Link from 'next/link'

import { C5SaleSwitch } from './c5-sale-switch'
import { TYPE } from './landing/type'
import { C5_TITLE } from './navigation/promo-config'

/** The signup form remains the primary action on email acquisition pages. */
export function C5SaleSecondaryLink() {
	return (
		<C5SaleSwitch>
			<p
				className={`${TYPE.meta} text-muted-foreground relative px-[18px] py-6 text-center sm:px-11`}
			>
				Looking for a live cohort?{' '}
				<Link
					href="/s/c5-site-cta"
					className="text-foreground underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
				>
					{C5_TITLE} is open now.
				</Link>
			</p>
		</C5SaleSwitch>
	)
}
