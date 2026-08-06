import { headers } from 'next/headers'
import LayoutClient from '@/components/layout-client'
import { Login } from '@/components/login'
import { getProviders } from '@/server/auth'

import { getCsrf } from './actions'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
	await headers()

	const providers = getProviders()
	const csrfToken = await getCsrf()

	return (
		<LayoutClient withContainer>
			<Login
				className="!min-h-[calc(100dvh-var(--nav-height))]"
				csrfToken={csrfToken}
				providers={providers}
				title={`Log in to AI Hero`}
				subtitle={`Use email to create an account. GitHub and Discord only sign in to accounts already linked.`}
			/>
		</LayoutClient>
	)
}
