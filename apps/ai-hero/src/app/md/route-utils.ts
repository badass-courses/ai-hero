import { NextResponse } from 'next/server'

type MarkdownRouteResource = {
	id?: string
	fields?: {
		slug?: string | null
		state?: string | null
		visibility?: string | null
	}
	resources?: MarkdownRouteResourceReference[] | null
}

type MarkdownRouteResourceReference = {
	resource?: MarkdownRouteResource | null
	metadata?: {
		tier?: string | null
	} | null
}

const markdownResponseHeaders = {
	'Content-Type': 'text/markdown; charset=utf-8',
	'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
} as const

export function createMarkdownResponse(markdown: string) {
	return new NextResponse(markdown, {
		headers: markdownResponseHeaders,
	})
}

export function markdownNotFoundResponse() {
	return new NextResponse('Not Found', { status: 404 })
}

export function isPublishedPublicResource(
	resource:
		| {
				fields?: {
					state?: string | null
					visibility?: string | null
				}
		  }
		| null
		| undefined,
) {
	return (
		resource?.fields?.state === 'published' &&
		resource?.fields?.visibility === 'public'
	)
}

export function findNestedResourceBySlug(
	resources: MarkdownRouteResourceReference[] | null | undefined,
	slug: string,
): MarkdownRouteResourceReference | null {
	for (const resourceReference of resources ?? []) {
		if (resourceReference.resource?.fields?.slug === slug) {
			return resourceReference
		}

		const nestedResource = findNestedResourceBySlug(
			resourceReference.resource?.resources ?? [],
			slug,
		)

		if (nestedResource) {
			return nestedResource
		}
	}

	return null
}
