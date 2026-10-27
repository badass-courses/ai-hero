/**
 * A sign-up queued behind an unreadable drovr state. Unlike the double opt-in
 * answer, no confirmation email is coming: the client renders it as a normal
 * enrolment and the background subscribe makes it true.
 */
export function deferredSubscribeResponse({
	email,
	name,
}: {
	email?: unknown
	name?: unknown
}) {
	return Response.json({
		email_address: typeof email === 'string' ? email.trim() : undefined,
		first_name: typeof name === 'string' && name.trim() ? name.trim() : null,
		state: 'deferred',
		fields: {},
	})
}

export function pendingSubscribeResponse({
	email,
	name,
}: {
	email?: unknown
	name?: unknown
}) {
	return Response.json({
		email_address: typeof email === 'string' ? email.trim() : undefined,
		first_name: typeof name === 'string' && name.trim() ? name.trim() : null,
		state: 'awaiting-confirmation',
		fields: {},
	})
}
