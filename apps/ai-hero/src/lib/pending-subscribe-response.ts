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
