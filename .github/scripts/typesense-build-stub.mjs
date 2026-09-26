// A stand-in Typesense for the Next build workflow: the search page (/q)
// prerenders an InstantSearch query, and without an answering server its
// prerender fails the build. Answers every search in a multi_search with an
// empty result, over HTTPS (the adapter hard-codes https) with a throwaway
// certificate the build trusts via NODE_EXTRA_CA_CERTS.
//
// Usage: node typesense-build-stub.mjs <cert.pem> <key.pem> [port]
import fs from 'node:fs'
import https from 'node:https'

const [certPath, keyPath, port = '8108'] = process.argv.slice(2)
if (!certPath || !keyPath) {
	console.error('usage: typesense-build-stub.mjs <cert.pem> <key.pem> [port]')
	process.exit(2)
}

const empty = (search) => ({
	facet_counts: [],
	found: 0,
	hits: [],
	out_of: 0,
	page: 1,
	request_params: {
		collection_name: search?.collection ?? 'content_production',
		per_page: Number(search?.per_page ?? 10),
		q: search?.q ?? '',
	},
	search_cutoff: false,
	search_time_ms: 0,
})

https
	.createServer(
		{ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
		(request, response) => {
			let body = ''
			request.on('data', (chunk) => {
				body += chunk
			})
			request.on('end', () => {
				let searches = [{}]
				try {
					const parsed = JSON.parse(body || '{}')
					if (Array.isArray(parsed.searches) && parsed.searches.length > 0)
						searches = parsed.searches
				} catch {
					// Not a multi_search body: answer one empty result.
				}
				const payload = request.url?.includes('multi_search')
					? { results: searches.map(empty) }
					: empty(searches[0])
				response.writeHead(200, { 'content-type': 'application/json' })
				response.end(JSON.stringify(payload))
			})
		},
	)
	.listen(Number(port), '127.0.0.1', () => {
		console.log(`typesense build stub on https://127.0.0.1:${port}`)
	})
