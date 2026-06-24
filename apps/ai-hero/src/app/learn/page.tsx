import type { Metadata } from 'next'
import { ComingSoon } from '@/components/coming-soon'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'

export const metadata: Metadata = {
	title: 'Start Here | AI Hero',
	description: 'Your guided map of everything you can learn at AI Hero.',
}

export default function LearnPage() {
	return (
		<LayoutClient withContainer>
			<HubLayout>
				<ComingSoon
					label="Learning Hub"
					title="Start Here"
					description="A guided map of the free learning at AI Hero is on the way. For now, browse the posts and tutorials."
				/>
			</HubLayout>
		</LayoutClient>
	)
}
