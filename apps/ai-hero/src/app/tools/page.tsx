import type { Metadata } from 'next'
import { ComingSoon } from '@/components/coming-soon'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'

export const metadata: Metadata = {
	title: 'Tools | AI Hero',
	description: 'Open source AI tools and projects from AI Hero.',
}

export default function ToolsPage() {
	return (
		<LayoutClient withContainer>
			<HubLayout>
				<ComingSoon
					label="Tools"
					title="AI Tools"
					description="A home for the open source AI tooling built at AI Hero is coming. In the meantime, explore the Skills."
				/>
			</HubLayout>
		</LayoutClient>
	)
}
