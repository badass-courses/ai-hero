import crypto from 'crypto'

import { type Post } from './posts'

export function generateContentHash(post: Post): string {
	const content = JSON.stringify({
		title: post.fields.title,
		body: post.fields.body,
		description: post.fields.description,
		slug: post.fields.slug,
	})
	return crypto.createHash('sha256').update(content).digest('hex')
}
