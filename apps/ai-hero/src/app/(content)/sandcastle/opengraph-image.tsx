import { getRepoStarCount } from '@/lib/github-stars-query'
import {
	getSandcastleDocs,
	getSandcastleWeeklyDownloads,
	SANDCASTLE_OWNER,
	SANDCASTLE_REPO,
} from '@/lib/sandcastle-docs'

import {
	renderSandcastleOg,
	SANDCASTLE_OG_SIZE,
} from './_components/sandcastle-og'

export const revalidate = 3600
export const size = SANDCASTLE_OG_SIZE
export const contentType = 'image/png'
export const alt = 'Sandcastle'

export default async function SandcastleOgImage() {
	const [docs, stars, downloads] = await Promise.all([
		getSandcastleDocs(),
		getRepoStarCount(SANDCASTLE_OWNER, SANDCASTLE_REPO),
		getSandcastleWeeklyDownloads(),
	])
	const stats = [
		stars !== null && {
			value: stars.toLocaleString('en-US'),
			label: 'GitHub stars',
		},
		downloads !== null && {
			value: downloads.toLocaleString('en-US'),
			label: 'npm downloads a week',
		},
	].filter((stat) => stat !== false)

	return renderSandcastleOg({
		title: docs.lead,
		stats,
	})
}
