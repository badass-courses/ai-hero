import { headers } from 'next/headers'
import LayoutClient from '@/components/layout-client'
import { Login } from '@/components/login'
import { getProviders } from '@/server/auth'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
	await headers()

	const providers = getProviders()

	return (
		<LayoutClient withContainer>
			<Login
				className="!min-h-[calc(100dvh-var(--nav-height))]"
				providers={providers}
				title={`Log in to AI Hero`}
				subtitle={`Choose GitHub, Discord, or email to continue.`}
			/>
		</LayoutClient>
	)
}
