/**
 * Viewport helpers for the admin sales globe.
 * Mouse: 3ds Max orbit/zoom mapped onto a centered globe.
 * Left or middle drag orbits. Wheel zooms toward the cursor. Z resets distance.
 */
export const DEFAULT_GLOBE_ALTITUDE = 2.35
export const ARROW_STEP_DEGREES = 8
export const ZOOM_STEP = 0.22
export const MIN_GLOBE_ALTITUDE = 0.45
export const MAX_GLOBE_ALTITUDE = 6
export const AUTO_ROTATE_SPEED = 0.5
export const IDLE_RESUME_MS = 8_000
export const LOOK_AT_MS = 900

/**
 * OrbitControls mouse action ids. Avoid importing `three` from this module.
 * @see THREE.MOUSE
 */
export const ORBIT_ACTION = {
	ROTATE: 0,
	DOLLY: 1,
	PAN: 2,
} as const

export type GlobePov = Readonly<{
	lat: number
	lng: number
	altitude: number
}>

/**
 * OrbitControls-compatible subset used by the canvas.
 */
export type GlobeOrbitControls = {
	autoRotate: boolean
	autoRotateSpeed: number
	enableDamping: boolean
	enablePan: boolean
	enableZoom: boolean
	rotateSpeed: number
	zoomSpeed: number
	zoomToCursor: boolean
	mouseButtons: {
		LEFT?: number
		MIDDLE?: number
		RIGHT?: number
	}
	addEventListener: (type: string, listener: () => void) => void
	removeEventListener: (type: string, listener: () => void) => void
}

export function clampLatitude(lat: number): number {
	return Math.max(-89.5, Math.min(89.5, lat))
}

export function wrapLongitude(lng: number): number {
	return ((((lng + 180) % 360) + 360) % 360) - 180
}

export function clampAltitude(altitude: number): number {
	return Math.max(MIN_GLOBE_ALTITUDE, Math.min(MAX_GLOBE_ALTITUDE, altitude))
}

/**
 * Apply one 3ds Max-style viewport key to the current camera.
 * Arrow keys orbit. Z is zoom extents. + / - zoom.
 */
export function povAfterViewportKey(
	pov: GlobePov,
	key: string,
): GlobePov | null {
	switch (key) {
		case 'ArrowLeft':
			return { ...pov, lng: wrapLongitude(pov.lng - ARROW_STEP_DEGREES) }
		case 'ArrowRight':
			return { ...pov, lng: wrapLongitude(pov.lng + ARROW_STEP_DEGREES) }
		case 'ArrowUp':
			return { ...pov, lat: clampLatitude(pov.lat + ARROW_STEP_DEGREES) }
		case 'ArrowDown':
			return { ...pov, lat: clampLatitude(pov.lat - ARROW_STEP_DEGREES) }
		case 'z':
		case 'Z':
			return { ...pov, altitude: DEFAULT_GLOBE_ALTITUDE }
		case '+':
		case '=':
			return { ...pov, altitude: clampAltitude(pov.altitude - ZOOM_STEP) }
		case '-':
		case '_':
			return { ...pov, altitude: clampAltitude(pov.altitude + ZOOM_STEP) }
		default:
			return null
	}
}

/**
 * Configure OrbitControls for grab-to-orbit and auto-rotate.
 * Wheel zoom stays off until the globe is clicked. Pan stays off:
 * globe.gl pins the orbit target at the planet center.
 */
export function configureSalesGlobeControls(
	controls: GlobeOrbitControls,
): void {
	controls.enableDamping = true
	controls.enablePan = false
	controls.enableZoom = false
	controls.zoomToCursor = true
	controls.rotateSpeed = 0.55
	controls.zoomSpeed = 0.85
	controls.autoRotate = true
	controls.autoRotateSpeed = AUTO_ROTATE_SPEED
	controls.mouseButtons.LEFT = ORBIT_ACTION.ROTATE
	controls.mouseButtons.MIDDLE = ORBIT_ACTION.ROTATE
	controls.mouseButtons.RIGHT = ORBIT_ACTION.ROTATE
}

/**
 * Wheel zoom is off until the operator clicks the globe. Page scroll stays page scroll.
 */
export function setSalesGlobeWheelCapture(
	controls: GlobeOrbitControls,
	captured: boolean,
): void {
	controls.enableZoom = captured
}
