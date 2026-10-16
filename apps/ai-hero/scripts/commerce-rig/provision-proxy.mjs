// @ts-nocheck: untyped Node operator tooling, covered by rig.test.mjs; not app code.
import http from 'node:http'
import net from 'node:net'
// The CLI falls back to an account-login flow on provisioning failures.
// This one-shot CONNECT proxy lets anonymous provisioning/downloads through,
// but cannot connect to Stripe's account-login API or dashboard.
const hosts = new Set(['ai.stripe.com', 'registry.npmjs.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
export async function provisioningProxy() {
  const sockets = new Set()
  const server = http.createServer((_, response) => { response.writeHead(403); response.end() })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('connect', (request, client, head) => {
    const [host, port] = request.url.split(':')
    if (!hosts.has(host) || port !== '443') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    const upstream = net.connect({ host, port: 443 })
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream))
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream); upstream.pipe(client)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() { for (const socket of sockets) socket.destroy(); server.close() },
  }
}
export const provisioningHosts = [...hosts]
