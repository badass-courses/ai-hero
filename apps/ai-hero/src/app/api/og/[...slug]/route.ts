// Static OG endpoints take precedence; unknown paths don't need an error page.
export function GET() {
	return new Response(null, { status: 404 })
}
