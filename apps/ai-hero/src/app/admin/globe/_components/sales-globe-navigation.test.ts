import { describe, expect, it } from 'vitest'
import {
	ORBIT_ACTION,
	clampAltitude,
	clampLatitude,
	configureSalesGlobeControls,
	povAfterViewportKey,
	wrapLongitude,
	type GlobeOrbitControls,
} from './sales-globe-navigation'

const origin = { lat: 12, lng: 40, altitude: 2.35 }

function fakeControls(): GlobeOrbitControls {
	return {
		autoRotate: false,
		autoRotateSpeed: 0,
		enableDamping: false,
		enablePan: true,
		enableZoom: false,
		rotateSpeed: 0,
		zoomSpeed: 0,
		zoomToCursor: false,
		mouseButtons: {},
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}
}

describe('sales globe navigation', () => {
	it('orbits with arrow keys and wraps longitude', () => {
		expect(povAfterViewportKey(origin, 'ArrowLeft')).toEqual({
			...origin,
			lng: 32,
		})
		expect(povAfterViewportKey({ ...origin, lng: 176 }, 'ArrowRight')?.lng).toBe(
			-176,
		)
		expect(povAfterViewportKey(origin, 'ArrowUp')?.lat).toBe(20)
		expect(povAfterViewportKey({ ...origin, lat: 88 }, 'ArrowUp')?.lat).toBe(
			89.5,
		)
	})

	it('maps Z to zoom extents and + / - to altitude', () => {
		expect(povAfterViewportKey({ ...origin, altitude: 4 }, 'Z')?.altitude).toBe(
			2.35,
		)
		expect(povAfterViewportKey(origin, '=')?.altitude).toBeLessThan(
			origin.altitude,
		)
		expect(povAfterViewportKey(origin, '-')?.altitude).toBeGreaterThan(
			origin.altitude,
		)
		expect(povAfterViewportKey(origin, 'Escape')).toBeNull()
	})

	it('clamps altitude and latitude', () => {
		expect(clampAltitude(0)).toBe(0.45)
		expect(clampAltitude(99)).toBe(6)
		expect(clampLatitude(-120)).toBe(-89.5)
		expect(wrapLongitude(190)).toBe(-170)
	})

	it('configures Max-style orbit buttons and auto-rotate', () => {
		const controls = fakeControls()
		configureSalesGlobeControls(controls)
		expect(controls.autoRotate).toBe(true)
		expect(controls.enablePan).toBe(false)
		expect(controls.enableZoom).toBe(true)
		expect(controls.zoomToCursor).toBe(true)
		expect(controls.mouseButtons.LEFT).toBe(ORBIT_ACTION.ROTATE)
		expect(controls.mouseButtons.MIDDLE).toBe(ORBIT_ACTION.ROTATE)
		expect(controls.mouseButtons.RIGHT).toBe(ORBIT_ACTION.ROTATE)
	})
})
