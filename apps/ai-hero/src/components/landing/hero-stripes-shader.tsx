'use client'

import * as React from 'react'

import { cn } from '@coursebuilder/ui/utils/cn'

type Vec3 = [number, number, number]
type Palette = [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3]

export type HeroStripesProps = {
	// Motion
	speed?: number
	seed?: number
	speedVariance?: number // 0..1 — how much per-column speeds differ
	alternateDirection?: number // 0 = all columns same direction, 1 = alternate
	// Layout
	stripeWidth?: number // column width as fraction of canvas height (aspect-corrected)
	blocksPerColumn?: number // how many color blocks fill the canvas height per column
	emptyBlockChance?: number // 0..1 — fraction of blocks rendered as background color
	skew?: number // horizontal shear: 0 = vertical, ±1 ≈ 45°, negative leans opposite
	// Color
	colors?: Palette
	background?: Vec3 // empty-block color
	saturation?: number
	intensity?: number
	// Riso treatments
	grain?: number
	grainTexture?: number
	grainScale?: number
	chromaOffset?: number
	vignette?: number
	// Cursor
	mouseFollow?: number
	mouseInfluence?: number
	mouseHalo?: number
	// CSS
	className?: string
}

// Sampled from public/landing/colorful-stripe.jpg with pastels punched up.
export const STRIPE_PALETTES: Record<string, Palette> = {
	brand: [
		[1.0, 0.42, 0.08], // orange
		[1.0, 0.36, 0.62], // magenta-pink
		[0.07, 0.28, 0.95], // blue
		[1.0, 0.78, 0.32], // gold
		[1.0, 0.78, 0.0], // yellow
		[0.96, 0.16, 0.12], // red
	],
	cool: [
		[0.07, 0.28, 0.95], // blue
		[1.0, 0.36, 0.62], // magenta
		[0.5, 0.0, 0.8], // purple
		[0.0, 0.7, 0.7], // teal
		[0.9, 0.9, 0.85], // cream
		[1.0, 0.42, 0.08], // orange accent
	],
	hot: [
		[1.0, 0.78, 0.0], // yellow
		[1.0, 0.42, 0.08], // orange
		[0.96, 0.16, 0.12], // red
		[1.0, 0.36, 0.62], // pink
		[0.5, 0.0, 0.8], // purple
		[0.07, 0.28, 0.95], // blue accent
	],
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
	vUv = aPos * 0.5 + 0.5;
	gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uRes;
uniform vec2 uMouse;
uniform float uTime;
uniform float uSpeed;
uniform float uSeed;
uniform float uSpeedVariance;
uniform float uAlternate;
uniform float uStripeWidth;
uniform float uBlocksPerColumn;
uniform float uEmptyChance;
uniform float uSkew;
uniform float uSaturation;
uniform float uIntensity;
uniform float uGrain;
uniform float uGrainTexture;
uniform float uGrainScale;
uniform float uChromaOffset;
uniform float uVignette;
uniform float uMouseInfluence;
uniform float uMouseHalo;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec3 uC4;
uniform vec3 uC5;
uniform vec3 uBg;
out vec4 fragColor;

float hash11(float n) {
	return fract(sin(n) * 43758.5453);
}

float hash21(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 pickColor(float key) {
	float s = clamp(key, 0.0, 0.99999) * 6.0;
	if (s < 1.0)      return uC0;
	else if (s < 2.0) return uC1;
	else if (s < 3.0) return uC2;
	else if (s < 4.0) return uC3;
	else if (s < 5.0) return uC4;
	else              return uC5;
}

// Compute the solid block color at a given aspect-corrected uv position.
// Pulled into a function so we can resample it at offset x for chromaOffset.
vec3 sampleBlock(vec2 uv, vec2 mouse, float t) {
	// Apply horizontal shear — slants columns into parallelograms.
	uv.x -= uv.y * uSkew;

	// Column index
	float colIdx = floor(uv.x / max(uStripeWidth, 0.001));
	float colHash = hash11(colIdx * 13.71 + 1.3);

	// Per-column speed (varies around 1.0 by speedVariance fraction)
	float colSpeed = mix(1.0, 0.4 + 1.2 * colHash, clamp(uSpeedVariance, 0.0, 1.0));

	// Per-column direction (mix between always-1 and alternating ±1)
	float alt = (mod(colIdx, 2.0) < 0.5) ? 1.0 : -1.0;
	float dir = mix(1.0, alt, clamp(uAlternate, 0.0, 1.0));

	// Mouse pulse adds a small vertical shift per column
	float md = distance(uv, mouse);
	float mousePulse = exp(-md * md * 8.0) * uMouseInfluence;
	float pulse = mousePulse * sin(t * 0.6 + colIdx) * 0.4;

	// Vertical position within the column, scrolled by time
	float yScaled = uv.y * max(uBlocksPerColumn, 0.5);
	float shift = dir * t * colSpeed * 0.5 + pulse;
	float yShifted = yScaled + shift;
	float blockIdx = floor(yShifted);

	// Pick color from palette using hash of (col, block)
	float colorKey = hash21(vec2(colIdx + 0.13, blockIdx + 0.71));
	vec3 color = pickColor(colorKey);

	// Some blocks render as background color (creates breathing room)
	float emptyKey = hash21(vec2(colIdx + 5.21, blockIdx + 9.37));
	float isEmpty = step(emptyKey, clamp(uEmptyChance, 0.0, 1.0));
	color = mix(color, uBg, isEmpty);

	return color;
}

void main() {
	float aspect = uRes.x / uRes.y;
	vec2 uv = vUv;
	uv.x *= aspect;

	vec2 mouse = uMouse;
	mouse.x *= aspect;

	float t = uTime * uSpeed + uSeed;

	// Sample the block color, with R and B channels offset for CMYK misregistration.
	vec2 chromaOff = vec2(uChromaOffset / max(uRes.y, 1.0), 0.0);
	vec3 cG = sampleBlock(uv, mouse, t);
	vec3 cR = sampleBlock(uv + chromaOff, mouse, t);
	vec3 cB = sampleBlock(uv - chromaOff, mouse, t);
	vec3 col = vec3(cR.r, cG.g, cB.b);

	// Saturation push, then intensity.
	float luma = dot(col, vec3(0.299, 0.587, 0.114));
	col = mix(vec3(luma), col, uSaturation);
	col *= uIntensity;

	// ---- GRAIN ----
	vec2 px = gl_FragCoord.xy / max(uGrainScale, 0.0001);

	float g1 = clamp(uGrain, 0.0, 1.0);
	float density1 = g1 * 0.45;
	float amp1 = g1 * 0.22;
	float h1 = hash21(px);
	float h2 = hash21(px + 71.3);
	col += vec3(step(1.0 - density1, h2) - step(1.0 - density1, h1)) * amp1;

	float g2 = clamp(uGrainTexture, 0.0, 1.0);
	vec2 px2 = floor(px * 0.45);
	float density2 = g2 * 0.5;
	float amp2 = g2 * 0.18;
	float h3 = hash21(px2);
	float h4 = hash21(px2 + 41.7);
	col += vec3(step(1.0 - density2, h4) - step(1.0 - density2, h3)) * amp2;

	// ---- MOUSE HALO ----
	float md = distance(uv, mouse);
	col += exp(-md * md * 18.0) * uMouseHalo;

	// ---- VIGNETTE ----
	vec2 vc = vUv * 2.0 - 1.0;
	float vd = dot(vc, vc);
	float vig = 1.0 - smoothstep(0.55, 1.6, vd);
	col *= mix(1.0, vig, uVignette);

	col = clamp(col, 0.0, 1.0);
	fragColor = vec4(col, 1.0);
}
`

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
	const sh = gl.createShader(type)
	if (!sh) return null
	gl.shaderSource(sh, src)
	gl.compileShader(sh)
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		// eslint-disable-next-line no-console
		console.error('stripes shader compile error:', gl.getShaderInfoLog(sh))
		gl.deleteShader(sh)
		return null
	}
	return sh
}

function linkProgram(
	gl: WebGL2RenderingContext,
	vs: WebGLShader,
	fs: WebGLShader,
) {
	const p = gl.createProgram()
	if (!p) return null
	gl.attachShader(p, vs)
	gl.attachShader(p, fs)
	gl.linkProgram(p)
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
		// eslint-disable-next-line no-console
		console.error('stripes program link error:', gl.getProgramInfoLog(p))
		gl.deleteProgram(p)
		return null
	}
	return p
}

export function HeroStripes({
	speed = 0.25,
	seed = 0,
	speedVariance = 0.7,
	alternateDirection = 1.0,
	stripeWidth = 0.12,
	blocksPerColumn = 3.5,
	emptyBlockChance = 0.0,
	skew = 0.0,
	colors = STRIPE_PALETTES.brand,
	background = [0.05, 0.05, 0.06],
	saturation = 1.25,
	intensity = 1.0,
	grain = 0.4,
	grainTexture = 0.35,
	grainScale = 1.0,
	chromaOffset = 1.5,
	vignette = 0.2,
	mouseFollow = 0.035,
	mouseInfluence = 0.4,
	mouseHalo = 0.1,
	className,
}: HeroStripesProps) {
	const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
	const uniformsRef = React.useRef({
		speed,
		seed,
		speedVariance,
		alternateDirection,
		stripeWidth,
		blocksPerColumn,
		emptyBlockChance,
		skew,
		colors,
		background,
		saturation,
		intensity,
		grain,
		grainTexture,
		grainScale,
		chromaOffset,
		vignette,
		mouseFollow,
		mouseInfluence,
		mouseHalo,
	})

	React.useEffect(() => {
		uniformsRef.current = {
			speed,
			seed,
			speedVariance,
			alternateDirection,
			stripeWidth,
			blocksPerColumn,
			emptyBlockChance,
			skew,
			colors,
			background,
			saturation,
			intensity,
			grain,
			grainTexture,
			grainScale,
			chromaOffset,
			vignette,
			mouseFollow,
			mouseInfluence,
			mouseHalo,
		}
	}, [
		speed,
		seed,
		speedVariance,
		alternateDirection,
		stripeWidth,
		blocksPerColumn,
		emptyBlockChance,
		colors,
		background,
		saturation,
		intensity,
		grain,
		grainTexture,
		grainScale,
		chromaOffset,
		vignette,
		mouseFollow,
		mouseInfluence,
		mouseHalo,
		skew,
	])

	React.useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return

		const gl = canvas.getContext('webgl2', {
			antialias: false,
			premultipliedAlpha: false,
			powerPreference: 'low-power',
		})
		if (!gl) return

		const vs = compileShader(gl, gl.VERTEX_SHADER, VERT)
		const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG)
		if (!vs || !fs) return
		const program = linkProgram(gl, vs, fs)
		if (!program) return

		const vao = gl.createVertexArray()
		gl.bindVertexArray(vao)
		const vbo = gl.createBuffer()
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1, -1, 3, -1, -1, 3]),
			gl.STATIC_DRAW,
		)
		const aPos = gl.getAttribLocation(program, 'aPos')
		gl.enableVertexAttribArray(aPos)
		gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

		const u = {
			res: gl.getUniformLocation(program, 'uRes'),
			mouse: gl.getUniformLocation(program, 'uMouse'),
			time: gl.getUniformLocation(program, 'uTime'),
			speed: gl.getUniformLocation(program, 'uSpeed'),
			seed: gl.getUniformLocation(program, 'uSeed'),
			speedVariance: gl.getUniformLocation(program, 'uSpeedVariance'),
			alternate: gl.getUniformLocation(program, 'uAlternate'),
			stripeWidth: gl.getUniformLocation(program, 'uStripeWidth'),
			blocksPerColumn: gl.getUniformLocation(program, 'uBlocksPerColumn'),
			emptyChance: gl.getUniformLocation(program, 'uEmptyChance'),
			skew: gl.getUniformLocation(program, 'uSkew'),
			saturation: gl.getUniformLocation(program, 'uSaturation'),
			intensity: gl.getUniformLocation(program, 'uIntensity'),
			grain: gl.getUniformLocation(program, 'uGrain'),
			grainTexture: gl.getUniformLocation(program, 'uGrainTexture'),
			grainScale: gl.getUniformLocation(program, 'uGrainScale'),
			chromaOffset: gl.getUniformLocation(program, 'uChromaOffset'),
			vignette: gl.getUniformLocation(program, 'uVignette'),
			mouseInfluence: gl.getUniformLocation(program, 'uMouseInfluence'),
			mouseHalo: gl.getUniformLocation(program, 'uMouseHalo'),
			bg: gl.getUniformLocation(program, 'uBg'),
			c: [
				gl.getUniformLocation(program, 'uC0'),
				gl.getUniformLocation(program, 'uC1'),
				gl.getUniformLocation(program, 'uC2'),
				gl.getUniformLocation(program, 'uC3'),
				gl.getUniformLocation(program, 'uC4'),
				gl.getUniformLocation(program, 'uC5'),
			],
		}

		gl.useProgram(program)

		const reduce =
			typeof window !== 'undefined' &&
			window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

		const resize = () => {
			const dpr = Math.min(window.devicePixelRatio || 1, 2)
			const w = Math.max(1, Math.floor(canvas.clientWidth * dpr))
			const h = Math.max(1, Math.floor(canvas.clientHeight * dpr))
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w
				canvas.height = h
				gl.viewport(0, 0, w, h)
			}
		}
		const ro = new ResizeObserver(resize)
		ro.observe(canvas)
		resize()

		let visible = true
		const io = new IntersectionObserver(
			(entries) => {
				visible = entries[0]?.isIntersecting ?? true
			},
			{ threshold: 0 },
		)
		io.observe(canvas)

		const target = { x: 0.5, y: 0.5 }
		const current = { x: 0.5, y: 0.5 }
		const onPointerMove = (e: PointerEvent) => {
			const rect = canvas.getBoundingClientRect()
			if (rect.width === 0 || rect.height === 0) return
			target.x = (e.clientX - rect.left) / rect.width
			target.y = 1.0 - (e.clientY - rect.top) / rect.height
		}
		window.addEventListener('pointermove', onPointerMove, { passive: true })

		let raf = 0
		const start = performance.now()

		const tick = (now: number) => {
			if (visible) {
				const uf = uniformsRef.current
				const t = reduce ? 1.7 : (now - start) / 1000
				current.x += (target.x - current.x) * uf.mouseFollow
				current.y += (target.y - current.y) * uf.mouseFollow
				const mx = 0.5 + (current.x - 0.5) * uf.mouseInfluence
				const my = 0.5 + (current.y - 0.5) * uf.mouseInfluence

				gl.uniform2f(u.res, canvas.width, canvas.height)
				gl.uniform2f(u.mouse, mx, my)
				gl.uniform1f(u.time, t)
				gl.uniform1f(u.speed, uf.speed)
				gl.uniform1f(u.seed, uf.seed)
				gl.uniform1f(u.speedVariance, uf.speedVariance)
				gl.uniform1f(u.alternate, uf.alternateDirection)
				gl.uniform1f(u.stripeWidth, uf.stripeWidth)
				gl.uniform1f(u.blocksPerColumn, uf.blocksPerColumn)
				gl.uniform1f(u.emptyChance, uf.emptyBlockChance)
				gl.uniform1f(u.skew, uf.skew)
				gl.uniform1f(u.saturation, uf.saturation)
				gl.uniform1f(u.intensity, uf.intensity)
				gl.uniform1f(u.grain, uf.grain)
				gl.uniform1f(u.grainTexture, uf.grainTexture)
				gl.uniform1f(u.grainScale, uf.grainScale)
				gl.uniform1f(u.chromaOffset, uf.chromaOffset)
				gl.uniform1f(u.vignette, uf.vignette)
				gl.uniform1f(u.mouseInfluence, uf.mouseInfluence)
				gl.uniform1f(u.mouseHalo, uf.mouseHalo)
				gl.uniform3f(u.bg, uf.background[0], uf.background[1], uf.background[2])
				const cols = uf.colors ?? STRIPE_PALETTES.brand!
				for (let i = 0; i < 6; i++) {
					const c = (cols[i] ?? cols[cols.length - 1])!
					const loc = u.c[i] ?? null
					gl.uniform3f(loc, c[0], c[1], c[2])
				}
				gl.drawArrays(gl.TRIANGLES, 0, 3)
			}
			if (reduce) return
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)

		return () => {
			cancelAnimationFrame(raf)
			window.removeEventListener('pointermove', onPointerMove)
			ro.disconnect()
			io.disconnect()
			gl.deleteBuffer(vbo)
			gl.deleteVertexArray(vao)
			gl.deleteProgram(program)
			gl.deleteShader(vs)
			gl.deleteShader(fs)
		}
	}, [])

	return (
		<canvas
			ref={canvasRef}
			aria-hidden
			className={cn('block h-full w-full', className)}
		/>
	)
}
