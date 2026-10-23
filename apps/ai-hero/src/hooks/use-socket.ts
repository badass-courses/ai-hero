import usePartySocket from 'partysocket/react'

// `process.env` directly rather than `@/env.mjs`: this hook is client code,
// and the env module brings t3-env and zod (65KB gz) into every page that
// mounts a socket — which, via `<Party/>`, was every page.
const PARTY_KIT_URL = process.env.NEXT_PUBLIC_PARTY_KIT_URL as string
const PARTYKIT_ROOM_NAME = process.env.NEXT_PUBLIC_PARTYKIT_ROOM_NAME as string

export function useSocket(options: {
	onOpen?: (event: WebSocketEventMap['open']) => void
	onMessage?: (event: WebSocketEventMap['message']) => void
	onClose?: (event: WebSocketEventMap['close']) => void
	onError?: (event: WebSocketEventMap['error']) => void
	room?: string | null
}) {
	return usePartySocket({
		host: PARTY_KIT_URL,
		...options,
		room: options.room || PARTYKIT_ROOM_NAME,
	})
}
