import type { Metadata } from 'next'

import HomePage, { metadata as homepageMetadata } from '../page'
import {
	getHomeCouponMetadata,
	type HomeCouponPageProps,
} from './metadata'

export const dynamic = 'force-dynamic'

export async function generateMetadata(
	props: HomeCouponPageProps,
): Promise<Metadata> {
	const metadata = await getHomeCouponMetadata(props)
	return {
		...metadata,
		title: homepageMetadata.title,
	}
}

export default HomePage
