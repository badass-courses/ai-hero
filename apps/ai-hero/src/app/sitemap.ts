import { getPublicSitemapEntries } from '@/lib/public-content-index'

export const revalidate = 3600

export default async function sitemap() {
	return getPublicSitemapEntries()
}
