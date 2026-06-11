'use client'

import * as React from 'react'

import { cn } from '@coursebuilder/ui/utils/cn'

type Vec3 = [number, number, number]
type Palette = [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3]

export type HeroShaderProps = {
	speed?: number
	seed?: number
	frequency?: number
	displacement?: number
	displacementFreq?: number
	mouseFollow?: number
	flowY?: number
	flowX?: number
	intensity?: number
	saturation?: number
	sharpness?: number
	grain?: number
	grainTexture?: number
	grainScale?: number
	grainSpeed?: number
	mouseInfluence?: number
	colors?: Palette
	// Fine print-character tweaks (each defaults to 0/off):
	chromaOffset?: number // pixels of R/B channel split — CMYK misregistration
	vignette?: number // 0..1 — soft edge darken
	mouseHalo?: number // 0..1 — soft bright spot following cursor
	posterize?: number // 0 = off, >=2 = banded steps in the color ramp
	colorDrift?: number // how fast the palette cycles over time
	className?: string
}

// Sampled from public/landing/colorful-stripe.jpg — the AI Hero brand stripe.
export const PALETTES: Record<string, Palette> = {
	brand: [
		[0.866, 0.431, 0.122], // orange
		[0.949, 0.749, 0.722], // pink
		[0.122, 0.31, 0.788], // blue
		[0.941, 0.902, 0.839], // cream
		[0.957, 0.769, 0.141], // yellow
		[0.839, 0.224, 0.141], // red
	],
	// Same hues as brand but with the pastels punched up so the flow stays vivid.
	brandVibrant: [
		[1.0, 0.42, 0.08], // orange
		[1.0, 0.36, 0.62], // magenta-pink (was pastel)
		[0.07, 0.28, 0.95], // blue
		[1.0, 0.78, 0.32], // warm gold (was cream)
		[1.0, 0.78, 0.0], // yellow
		[0.96, 0.16, 0.12], // red
	],
	brandHot: [
		[0.957, 0.769, 0.141], // yellow
		[0.866, 0.431, 0.122], // orange
		[0.839, 0.224, 0.141], // red
		[0.949, 0.749, 0.722], // pink
		[0.122, 0.31, 0.788], // blue
		[0.941, 0.902, 0.839], // cream
	],
	rainbow: [
		[1.0, 0.2, 0.2],
		[1.0, 0.55, 0.1],
		[1.0, 0.85, 0.15],
		[0.25, 0.8, 0.35],
		[0.2, 0.45, 0.95],
		[0.65, 0.25, 0.9],
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
uniform float uFreq;
uniform float uDispAmp;
uniform float uDispFreq;
uniform float uFlowY;
uniform float uFlowX;
uniform float uIntensity;
uniform float uSaturation;
uniform float uSharpness;
uniform float uGrain;
uniform float uGrainTexture;
uniform float uGrainScale;
uniform float uGrainSpeed;
uniform float uChromaOffset;
uniform float uVignette;
uniform float uMouseHalo;
uniform float uPosterize;
uniform float uColorDrift;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec3 uC4;
uniform vec3 uC5;
out vec4 fragColor;

float grainHash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 ramp(float t) {
	t = fract(t);
	float s = t * 6.0;
	float idx = floor(s);
	float w = mix(0.5, 0.04, clamp(uSharpness, 0.0, 1.0));
	float f = smoothstep(0.5 - w, 0.5 + w, fract(s));
	vec3 a, b;
	if (idx < 0.5)      { a = uC0; b = uC1; }
	else if (idx < 1.5) { a = uC1; b = uC2; }
	else if (idx < 2.5) { a = uC2; b = uC3; }
	else if (idx < 3.5) { a = uC3; b = uC4; }
	else if (idx < 4.5) { a = uC4; b = uC5; }
	else                { a = uC5; b = uC0; }
	return mix(a, b, f);
}

vec2 gentleDisplacement(vec2 uv, vec2 mouse, float t) {
	float dist = length(uv - mouse);
	return uv + uDispAmp * sin(uv.xy * uDispFreq + dist * uDispFreq + t);
}

float flowPattern(vec2 uv, float t) {
	float a = sin(uv.x * uFreq + t) * 0.5 + 0.5;
	float b = sin((uv.x + uv.y * uFlowX) * uFreq * 0.7 - t * 0.6) * 0.5 + 0.5;
	float c = sin((uv.x * 0.5 - uv.y * uFlowY * 0.4) * uFreq * 1.3 + t * 0.4) * 0.5 + 0.5;
	return (a + b * 0.7 + c * 0.5) / 2.2;
}

void main() {
	float aspect = uRes.x / uRes.y;
	vec2 uv = vUv;
	uv.x *= aspect;

	vec2 mouse = uMouse;
	mouse.x *= aspect;

	float t = uTime * uSpeed + uSeed;
	uv = gentleDisplacement(uv, mouse, t);

	// Sample the flow at three slightly offset positions — when chromaOffset > 0
	// the R and B channels split horizontally like CMYK misregistration.
	vec2 chromaOff = vec2(uChromaOffset / max(uRes.y, 1.0), 0.0);
	float patG = flowPattern(uv, t);
	float patR = flowPattern(uv + chromaOff, t);
	float patB = flowPattern(uv - chromaOff, t);

	// Optional posterize: snap pattern values into N flat bands.
	float steps = max(uPosterize, 1.0);
	float poster = step(1.5, uPosterize);
	patG = mix(patG, (floor(patG * steps) + 0.5) / steps, poster);
	patR = mix(patR, (floor(patR * steps) + 0.5) / steps, poster);
	patB = mix(patB, (floor(patB * steps) + 0.5) / steps, poster);

	float drift = t * uColorDrift;
	vec3 col = vec3(
		ramp(patR + drift).r,
		ramp(patG + drift).g,
		ramp(patB + drift).b
	);

	// Saturation boost before grain so the chroma boost doesn't amplify noise.
	float luma = dot(col, vec3(0.299, 0.587, 0.114));
	col = mix(vec3(luma), col, uSaturation);
	col *= uIntensity;

	// ---- GRAIN ----
	// Threshold-gated binary stipple — most pixels stay clean, a percentage
	// get a discrete dark/light ink dot. Feels like riso print, not luma fuzz.
	vec2 px = gl_FragCoord.xy / max(uGrainScale, 0.0001);
	float grainTime = floor(uTime * uGrainSpeed);

	// Fine layer (1px dots). Grain knob controls density AND amplitude together
	// so at low values there are few dots AND they're faint.
	float g1 = clamp(uGrain, 0.0, 1.0);
	float density1 = g1 * 0.45;
	float amp1 = g1 * 0.22;
	float h1 = grainHash(px + grainTime);
	float h2 = grainHash(px + grainTime + 71.3);
	col += vec3(step(1.0 - density1, h2) - step(1.0 - density1, h1)) * amp1;

	// Chunky layer (2-3px blobs) via quantization.
	float g2 = clamp(uGrainTexture, 0.0, 1.0);
	vec2 px2 = floor(px * 0.45);
	float density2 = g2 * 0.5;
	float amp2 = g2 * 0.18;
	float h3 = grainHash(px2 + grainTime);
	float h4 = grainHash(px2 + grainTime + 41.7);
	col += vec3(step(1.0 - density2, h4) - step(1.0 - density2, h3)) * amp2;

	// ---- MOUSE HALO ----
	// Soft additive bloom around the cursor — calmer than displacement.
	float md = distance(uv, mouse);
	col += exp(-md * md * 18.0) * uMouseHalo;

	// ---- VIGNETTE ----
	// Pull corners down a touch to integrate with surrounding page.
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
		console.error('shader compile error:', gl.getShaderInfoLog(sh))
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
		console.error('program link error:', gl.getProgramInfoLog(p))
		gl.deleteProgram(p)
		return null
	}
	return p
}

export function HeroShader({
	speed = 0.6,
	seed = 0.0,
	frequency = 8.0,
	displacement = 0.122,
	displacementFreq = 5.0,
	mouseFollow = 0.035,
	flowY = 0.5,
	flowX = 0.0,

	intensity = 1.0,
	saturation = 1.25,
	sharpness = 0,
	grain = 0.0,
	grainTexture = 0,
	grainScale = 0.5,
	grainSpeed = 0.0,
	mouseInfluence = 0.6,
	chromaOffset = 0.0,
	vignette = 0.0,
	mouseHalo = 0.0,
	posterize = 0.0,
	colorDrift = 0.04,
	colors = PALETTES.brandVibrant,
	className,
}: HeroShaderProps) {
	const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
	const uniformsRef = React.useRef({
		speed,
		seed,
		frequency,
		displacement,
		displacementFreq,
		mouseFollow,
		flowY,
		flowX,
		intensity,
		saturation,
		sharpness,
		grain,
		grainTexture,
		grainScale,
		grainSpeed,
		mouseInfluence,
		chromaOffset,
		vignette,
		mouseHalo,
		posterize,
		colorDrift,
		colors,
	})

	React.useEffect(() => {
		uniformsRef.current = {
			speed,
			seed,
			frequency,
			displacement,
			displacementFreq,
			mouseFollow,
			flowY,
			flowX,
			intensity,
			saturation,
			sharpness,
			grain,
			grainTexture,
			grainScale,
			grainSpeed,
			mouseInfluence,
			chromaOffset,
			vignette,
			mouseHalo,
			posterize,
			colorDrift,
			colors,
		}
	}, [
		speed,
		seed,
		frequency,
		displacement,
		displacementFreq,
		mouseFollow,
		flowY,
		flowX,
		intensity,
		saturation,
		sharpness,
		grain,
		grainTexture,
		grainScale,
		grainSpeed,
		mouseInfluence,
		chromaOffset,
		vignette,
		mouseHalo,
		posterize,
		colorDrift,
		colors,
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

		const uRes = gl.getUniformLocation(program, 'uRes')
		const uMouse = gl.getUniformLocation(program, 'uMouse')
		const uTime = gl.getUniformLocation(program, 'uTime')
		const uSpeed = gl.getUniformLocation(program, 'uSpeed')
		const uSeed = gl.getUniformLocation(program, 'uSeed')
		const uFreq = gl.getUniformLocation(program, 'uFreq')
		const uDispAmp = gl.getUniformLocation(program, 'uDispAmp')
		const uDispFreq = gl.getUniformLocation(program, 'uDispFreq')
		const uFlowY = gl.getUniformLocation(program, 'uFlowY')
		const uFlowX = gl.getUniformLocation(program, 'uFlowX')
		const uIntensity = gl.getUniformLocation(program, 'uIntensity')
		const uSaturation = gl.getUniformLocation(program, 'uSaturation')
		const uSharpness = gl.getUniformLocation(program, 'uSharpness')
		const uGrain = gl.getUniformLocation(program, 'uGrain')
		const uGrainTexture = gl.getUniformLocation(program, 'uGrainTexture')
		const uGrainScale = gl.getUniformLocation(program, 'uGrainScale')
		const uGrainSpeed = gl.getUniformLocation(program, 'uGrainSpeed')
		const uChromaOffset = gl.getUniformLocation(program, 'uChromaOffset')
		const uVignette = gl.getUniformLocation(program, 'uVignette')
		const uMouseHalo = gl.getUniformLocation(program, 'uMouseHalo')
		const uPosterize = gl.getUniformLocation(program, 'uPosterize')
		const uColorDrift = gl.getUniformLocation(program, 'uColorDrift')
		const uC = [
			gl.getUniformLocation(program, 'uC0'),
			gl.getUniformLocation(program, 'uC1'),
			gl.getUniformLocation(program, 'uC2'),
			gl.getUniformLocation(program, 'uC3'),
			gl.getUniformLocation(program, 'uC4'),
			gl.getUniformLocation(program, 'uC5'),
		]

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
				const u = uniformsRef.current
				const t = reduce ? 1.7 : (now - start) / 1000
				current.x += (target.x - current.x) * u.mouseFollow
				current.y += (target.y - current.y) * u.mouseFollow
				const mx = 0.5 + (current.x - 0.5) * u.mouseInfluence
				const my = 0.5 + (current.y - 0.5) * u.mouseInfluence
				gl.uniform2f(uRes, canvas.width, canvas.height)
				gl.uniform2f(uMouse, mx, my)
				gl.uniform1f(uTime, t)
				gl.uniform1f(uSpeed, u.speed)
				gl.uniform1f(uSeed, u.seed)
				gl.uniform1f(uFreq, u.frequency)
				gl.uniform1f(uDispAmp, u.displacement)
				gl.uniform1f(uDispFreq, u.displacementFreq)
				gl.uniform1f(uFlowY, u.flowY)
				gl.uniform1f(uFlowX, u.flowX)
				gl.uniform1f(uIntensity, u.intensity)
				gl.uniform1f(uSaturation, u.saturation)
				gl.uniform1f(uSharpness, u.sharpness)
				gl.uniform1f(uGrain, u.grain)
				gl.uniform1f(uGrainTexture, u.grainTexture)
				gl.uniform1f(uGrainScale, u.grainScale)
				gl.uniform1f(uGrainSpeed, u.grainSpeed)
				gl.uniform1f(uChromaOffset, u.chromaOffset)
				gl.uniform1f(uVignette, u.vignette)
				gl.uniform1f(uMouseHalo, u.mouseHalo)
				gl.uniform1f(uPosterize, u.posterize)
				gl.uniform1f(uColorDrift, u.colorDrift)
				const cols = u.colors ?? PALETTES.brand!
				for (let i = 0; i < 6; i++) {
					const c = (cols[i] ?? cols[cols.length - 1])!
					const loc = uC[i] ?? null
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
