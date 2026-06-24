import type { Metadata } from 'next'
import { ComingSoon } from '@/components/coming-soon'
import LayoutClient from '@/components/layout-client'

export const metadata: Metadata = {
	title: 'Principles | AI Hero',
	description: 'The engineering philosophy and workflow behind AI Hero.',
}

export default function PrinciplesPage() {
	return (
		<LayoutClient withContainer>
			<ComingSoon
				label="Principles"
				title="The AI Hero Way"
				description="The engineering philosophy and process behind AI Hero is being written up. Check back soon."
			/>
		</LayoutClient>
	)
}
