import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'

/**
 * A link with `?t=` starts playing on load, like YouTube's timestamp links —
 * which is also what a /videos card sends after its preview has played, so
 * clicking carries on where it was, playing.
 *
 * Plays with sound, as the click that brought the viewer here allows; if the
 * browser still refuses audio (Safari can), plays muted rather than not at all.
 */
export function playFromLink(player: MuxPlayerRefAttributes | null) {
	player?.play().catch(() => {
		if (!player) return
		player.muted = true
		player.play().catch(console.warn)
	})
}
