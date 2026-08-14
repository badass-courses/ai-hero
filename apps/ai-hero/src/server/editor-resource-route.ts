import { NextRequest, NextResponse } from 'next/server'

import {
	EditorResourceError,
	formatEditorResourceEtag,
} from '@/lib/editor-resource'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'

export const editorResourceCorsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, PATCH, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
	'Access-Control-Expose-Headers': 'ETag',
}

export function editorResourceOptionsResponse() {
	return NextResponse.json({}, { headers: editorResourceCorsHeaders })
}

export async function authenticateEditorResourceRequest(request: NextRequest) {
	const [scheme, credential, ...extra] =
		request.headers.get('Authorization')?.trim().split(/\s+/) ?? []
	if (scheme?.toLowerCase() !== 'bearer' || !credential || extra.length > 0) {
		return {
			ok: false,
			response: NextResponse.json(
				{
					error: 'Unauthorized: use Authorization: Bearer <device-token>',
					docs: '/api',
				},
				{ status: 401, headers: editorResourceCorsHeaders },
			),
		} as const
	}

	const auth = await getUserAbilityForRequest(request)
	if (!auth.user) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: 'Unauthorized', docs: '/api' },
				{ status: 401, headers: editorResourceCorsHeaders },
			),
		} as const
	}
	if (auth.authMethod !== 'device-token') {
		await log.warn('api.editor.resources.auth-method.denied', {
			userId: auth.user.id,
			authMethod: auth.authMethod,
		})
		return {
			ok: false,
			response: NextResponse.json(
				{
					error: 'Forbidden: a role-derived OAuth device token is required',
					docs: '/api',
				},
				{ status: 403, headers: editorResourceCorsHeaders },
			),
		} as const
	}

	return {
		ok: true,
		context: {
			userId: auth.user.id,
			isAdmin: auth.ability.can('manage', 'all'),
		},
		user: auth.user,
	} as const
}

export function editorResourceJson(
	body: unknown,
	options: { status?: number; revision?: string } = {},
) {
	return NextResponse.json(body, {
		status: options.status,
		headers: {
			...editorResourceCorsHeaders,
			...(options.revision
				? { ETag: formatEditorResourceEtag(options.revision) }
				: {}),
		},
	})
}

export async function editorResourceErrorResponse(
	error: unknown,
	data: Record<string, unknown>,
) {
	if (error instanceof EditorResourceError) {
		const writer = error.status >= 409 ? log.warn : log.info
		await writer('api.editor.resources.request.rejected', {
			...data,
			code: error.code,
			status: error.status,
		})
		return editorResourceJson(
			{ error: error.message, code: error.code, docs: '/api' },
			{ status: error.status },
		)
	}

	await log.error('api.editor.resources.request.failed', {
		...data,
		error: error instanceof Error ? error.message : 'Unknown error',
		stack: error instanceof Error ? error.stack : undefined,
	})
	return editorResourceJson({ error: 'Internal server error' }, { status: 500 })
}
