import { NextResponse } from 'next/server'
import { oidcAuthorizationCodeFields } from '@/lib/learner-agent/oauth/metadata'

export async function GET() {
	const config = {
		token_endpoint: `${process.env.NEXT_PUBLIC_URL}/oauth/token`,
		token_endpoint_auth_methods_supported: [],
		response_types_supported: ['token'],
		scopes_supported: ['content:read', 'progress'],
		issuer: `${process.env.NEXT_PUBLIC_URL}/oauth`,
		registration_endpoint: `${process.env.NEXT_PUBLIC_URL}/oauth/register`,
		device_authorization_endpoint: `${process.env.NEXT_PUBLIC_URL}/oauth/device/code`,
		claims_supported: ['email'],
		userinfo_endpoint: `${process.env.NEXT_PUBLIC_URL}/oauth/userinfo`,
		// Additive: the learner MCP's authorization code flow. The fields above
		// stay as they are for the CLI's device flow.
		...oidcAuthorizationCodeFields(),
	}

	return NextResponse.json(config)
}
