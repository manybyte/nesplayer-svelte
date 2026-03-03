<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import createNESPlayerModule from '$lib/wasm/nes-player.js';
	import { audioWorkletSrc } from '$lib/wasm/audio-worklet-src.js';
	import ControllerPanel from './ControllerPanel.svelte';
	import { version } from '$lib/version.js';
	import { unzipSync } from 'fflate';

	interface NESModule {
		HEAPU8:                Uint8Array;
		_malloc:               (size: number) => number;
		_free:                 (ptr: number) => void;
		_init:                 () => void;
		_powerOn:              () => void;
		_powerOff:             () => void;
		_reset:                () => void;
		_pause:                () => void;
		_resume:               () => void;
		_isPaused:             () => number;
		_tickFrame:            (maxCycles: number) => number;
		_loadNESROM:           (ptr: number, size: number) => number;
		_getFramebufferPtr:    () => number;
		_getPPUFrame:          () => number;
		_setButtons:           (controller: number, mask: number) => void;
		_getSRAMPtr:           () => number;
		_getSRAMSize:          () => number;
		_hasBattery:           () => number;
		_getSRAMDirty:         () => number;
		_clearSRAMDirty:       () => void;
		_getFlashDirty:        () => number;
		_clearFlashDirty:      () => void;
		_getPRGRomPtr:         () => number;
		_getPRGRomSize:        () => number;
		_setAudioSampleRate:   (rate: number) => void;
		_getAudioBufferPtr:    () => number;
		_getAudioSampleCount:  () => number;
		_clearAudioSamples:    () => void;
		_getCPUHz:             () => number;
		_getCyclesPerFrame:    () => number;
		_getRegion:            () => number;
		_setRegion:            (region: number) => void;
		_saveCPUState:         () => number;
		_getStateBufPtr:       () => number;
		_restoreCPUState:      (ptr: number, size: number) => void;
	}

	interface Props {
		rom?:        Uint8Array;
		romName?:    string;
		volume?:     number;
		muted?:      boolean;
		sampleRate?: 48000 | 44100;
	}

	let {
		rom,
		romName,
		volume     = $bindable(1),
		muted      = $bindable(false),
		sampleRate = $bindable<48000 | 44100>(48000),
	}: Props = $props();

	const SCREEN_W  = 256;
	const SCREEN_H  = 240;
	const ASPECT    = (SCREEN_W * 8 / 7) / SCREEN_H;
	const RING_SIZE = 8192;

	const VERT_SRC = `
		attribute vec2 a_position;
		attribute vec2 a_texCoord;
		varying vec2 v_texCoord;
		void main() {
			gl_Position = vec4(a_position, 0.0, 1.0);
			v_texCoord = a_texCoord;
		}
	`;

	const FRAG_SRC = `
		precision mediump float;
		uniform sampler2D u_texture;
		varying vec2 v_texCoord;
		void main() {
			gl_FragColor = texture2D(u_texture, v_texCoord);
		}
	`;

	const DEFAULT_GAMEPAD_BUTTON_MAP: Record<number, number> = {
		0: 0x01, 1: 0x02, 8: 0x04, 9: 0x08,
		12: 0x10, 13: 0x20, 14: 0x40, 15: 0x80,
	};

	const DEFAULT_KEYMAP: Record<string, number> = {
		ArrowUp:    0x10,
		ArrowDown:  0x20,
		ArrowLeft:  0x40,
		ArrowRight: 0x80,
		ShiftRight: 0x04,
		Enter:      0x08,
		KeyZ:       0x02,
		KeyX:       0x01,
	};

	const INPUT_CONFIG_KEY = 'nesplayer-input-config';

	type InputConfig = {
		player1Input:    PlayerInput;
		player2Input:    PlayerInput;
		player1KeyMap:   Record<string, number>;
		player2KeyMap:   Record<string, number>;
		gamepadProfiles: GamepadProfile[];
		quickSaveKey:    string;
		quickLoadKey:    string;
	};

	let container  = $state<HTMLDivElement | undefined>();
	let canvas     = $state<HTMLCanvasElement | undefined>();
	let fileInput  = $state<HTMLInputElement | undefined>();
	let overlayTop  = $state(0);
	let overlayH    = $state(0);
	let overlayLeft = $state(0);
	let overlayW    = $state(0);
	let nes        = $state.raw<NESModule | null>(null);

	let currentRomName = '';
	let currentRomData: Uint8Array | null = null;
	let autoPaused     = $state(false);
	let cursorHidden   = $state(false);
	let cursorTimer    = 0;

	let gl:         WebGLRenderingContext | null = null;
	let texture:    WebGLTexture | null         = null;
	let program:    WebGLProgram | null         = null;
	let posBuf:     WebGLBuffer | null          = null;
	let texBuf:     WebGLBuffer | null          = null;
	let animId:     number                      = 0;
	let lastTime:   number                      = 0;
	let cycleAccum: number                      = 0;
	let staticBuf   = new Uint8Array(SCREEN_W * SCREEN_H * 4);

	let audioCtx:   AudioContext | null     = null;
	let gainNode:   GainNode | null         = null;
	let headerView: Int32Array | null       = null;
	let ringView:   Float32Array | null     = null;

	let held        = new SvelteSet<string>();
	let showOverlay  = $state(false);
	let powered      = $state(false);
	let paused       = $state(false);
	let userRegion   = $state<'auto' | 'ntsc' | 'pal'>('auto');
	let autoRegion   = 0;
	let isFullscreen        = $state(false);
	let showControllerPanel = $state(false);

	type GamepadInfo    = { id: string; index: number; name: string };
	type GamepadProfile = { id: string; buttonMap: Record<number, number>; quickSaveBtn?: number | null; quickLoadBtn?: number | null };
	type PlayerInput    = { type: 'keyboard' } | { type: 'gamepad'; id: string } | { type: 'none' };

	let detectedGamepads = $state<GamepadInfo[]>([]);
	let gamepadProfiles  = $state<GamepadProfile[]>([]);
	let player1Input     = $state<PlayerInput>({ type: 'keyboard' });
	let player2Input     = $state<PlayerInput>({ type: 'none' });
	let player1KeyMap    = $state<Record<string, number>>({ ...DEFAULT_KEYMAP });
	let player2KeyMap    = $state<Record<string, number>>({});
	let quickSaveKey     = $state('F5');
	let quickLoadKey     = $state('F7');

	let quickSaveState    = $state<Uint8Array | null>(null);
	let stateMessage      = $state<string | null>(null);
	let stateMessageTimer = 0;
	let gpQsSavePrev: Record<string, boolean> = {};
	let gpQsLoadPrev: Record<string, boolean> = {};

	let cachedZipData: Uint8Array | null = null;
	let cachedZipName: string | null = null;
	type ZipEntry = { path: string; data: Uint8Array };
	let zipEntries = $state<ZipEntry[]>([]);
	let zipEntryIndex = $state(0);
	let zipStemName = $state('');
	let showZipChooser = $state(false);
	let zipChooserList = $state<HTMLDivElement | undefined>();
	let dropTarget = $state(false);
	let lastPickHandle: FileSystemFileHandle | null = null;

	let autoRevertPads: Record<string, 1 | 2> = {};
	let controllerPanelAutoPaused = false;
	let configLoaded             = $state(false);
	let savedP1GamepadId     = '';
	let savedP2GamepadId     = '';

	function padName(id: string): string {
		const m = id.match(/^([^(]+)/);
		return m ? m[1].trim() : id;
	}

	function padInfo(gp: Gamepad): GamepadInfo {
		return { id: gp.id, index: gp.index, name: padName(gp.id) };
	}

	function loadInputConfig() {
		try {
			const raw = localStorage.getItem(INPUT_CONFIG_KEY);
			if (!raw) { return; }
			const cfg = JSON.parse(raw) as InputConfig;
			if (cfg.player1Input) {
				player1Input = cfg.player1Input;
				if (cfg.player1Input.type === 'gamepad') { savedP1GamepadId = cfg.player1Input.id; }
			}
			if (cfg.player2Input) {
				player2Input = cfg.player2Input;
				if (cfg.player2Input.type === 'gamepad') { savedP2GamepadId = cfg.player2Input.id; }
			}
			if (cfg.player1KeyMap)   { player1KeyMap   = cfg.player1KeyMap; }
			if (cfg.player2KeyMap)   { player2KeyMap   = cfg.player2KeyMap; }
			if (cfg.gamepadProfiles) { gamepadProfiles = cfg.gamepadProfiles; }
			if (cfg.quickSaveKey)    { quickSaveKey    = cfg.quickSaveKey; }
			if (cfg.quickLoadKey)    { quickLoadKey    = cfg.quickLoadKey; }
		} catch { }
	}

	function showStateMessage(msg: string) {
		stateMessage = msg;
		clearTimeout(stateMessageTimer);
		stateMessageTimer = window.setTimeout(() => { stateMessage = null; }, 1500);
	}

	function quickSave() {
		if (!nes || !powered) { return; }
		const size     = nes._saveCPUState();
		const ptr      = nes._getStateBufPtr();
		quickSaveState = nes.HEAPU8.slice(ptr, ptr + size);
		if (currentRomName) {
			localStorage.setItem(`nesplayer-${currentRomName}.state`, bytesToBase64(quickSaveState));
		}
		showStateMessage('State saved');
	}

	function quickLoad() {
		if (!nes || !powered || !quickSaveState) { return; }
		const ptr = nes._malloc(quickSaveState.length);
		nes.HEAPU8.set(quickSaveState, ptr);
		nes._restoreCPUState(ptr, quickSaveState.length);
		nes._free(ptr);
		nes._resume();
		paused     = false;
		autoPaused = false;
		lastTime   = 0;
		cycleAccum = 0;
		showStateMessage('State loaded');
	}

	function onContainerFocusIn() {
		if (!nes || !autoPaused) { return; }
		nes._resume();
		autoPaused = false;
	}

	function onContainerFocusOut(e: FocusEvent) {
		if (container?.contains(e.relatedTarget as Node)) { return; }
		if (!nes || paused || !powered) { return; }
		nes._pause();
		autoPaused = true;
	}

	function onContainerDblClick() {
		if (!nes || !powered) { return; }
		if (paused || autoPaused) {
			nes._resume();
			paused     = false;
			autoPaused = false;
		} else {
			nes._pause();
			paused = true;
		}
	}

	function onContainerPointerDown() {
		container?.focus({ preventScroll: true });
	}

	function onContainerMouseMove(e: MouseEvent) {
		if (!container) {
			return;
		}
		const rect        = container.getBoundingClientRect();
		const canvasRight = rect.right - overlayLeft;
		showOverlay = canvasRight - e.clientX <= 52;
		cursorHidden = false;
		clearTimeout(cursorTimer);
		if (powered && !paused && !autoPaused) {
			cursorTimer = window.setTimeout(() => { cursorHidden = true; }, 3000);
		}
	}

	function onContainerMouseLeave() {
		showOverlay = false;
		cursorHidden = false;
		clearTimeout(cursorTimer);
	}

	function pollPlayer(input: PlayerInput, kmap: Record<string, number>): number {
		let mask = 0;
		if (input.type === 'keyboard') {
			for (const [code, bit] of Object.entries(kmap)) {
				if (held.has(code)) { mask |= bit; }
			}
		} else if (input.type === 'gamepad') {
			const pad = [...navigator.getGamepads()].find(p => p?.connected && p.id === input.id) ?? null;
			if (pad) {
				const profile = gamepadProfiles.find(p => p.id === input.id);
				const bmap    = profile?.buttonMap ?? DEFAULT_GAMEPAD_BUTTON_MAP;
				for (const [idx, bit] of Object.entries(bmap)) {
					if (pad.buttons[Number(idx)]?.pressed) { mask |= bit; }
				}
				if (pad.axes[0] < -0.5) { mask |= 0x40; }
				if (pad.axes[0] >  0.5) { mask |= 0x80; }
				if (pad.axes[1] < -0.5) { mask |= 0x10; }
				if (pad.axes[1] >  0.5) { mask |= 0x20; }
			}
		}
		return mask;
	}

	function pushSamples(samples: Float32Array) {
		if (!headerView || !ringView) {
			return;
		}
		const writePos  = Atomics.load(headerView, 0);
		const readPos   = Atomics.load(headerView, 1);
		const available = RING_SIZE - ((writePos - readPos + RING_SIZE) % RING_SIZE) - 1;
		const count     = Math.min(samples.length, available);
		for (let i = 0; i < count; i++) {
			ringView[(writePos + i) % RING_SIZE] = samples[i];
		}
		Atomics.store(headerView, 0, (writePos + count) % RING_SIZE);
	}

	function getAudioSamples(module: NESModule): Float32Array {
		const count = module._getAudioSampleCount();
		if (count === 0) {
			return new Float32Array(0);
		}
		const ptr     = module._getAudioBufferPtr();
		const samples = new Float32Array(module.HEAPU8.buffer, ptr, count);
		const copy    = new Float32Array(count);
		copy.set(samples);
		module._clearAudioSamples();
		return copy;
	}

	function bytesToBase64(data: Uint8Array): string {
		let str = '';
		const CHUNK = 0x8000;
		for (let i = 0; i < data.length; i += CHUNK) {
			str += String.fromCharCode(...data.subarray(i, i + CHUNK));
		}
		return btoa(str);
	}

	function isVisibleNesFile(f: { name: string }): boolean {
		if (!f.name.endsWith('.nes')) { return false; }
		if (f.name.includes('__MACOSX/')) { return false; }
		let base = f.name.split('/').pop() ?? '';
		return !base.startsWith('.');
	}

	function openZipChooser(zipName: string, entries: [string, Uint8Array][]) {
		zipStemName = zipName.endsWith('.zip') ? zipName.slice(0, -4) : zipName;
		zipEntries  = entries.map(([path, data]) => ({ path, data }));
		zipEntryIndex = 0;
		showZipChooser = true;
	}

	async function bootRomEntry(module: NESModule, data: Uint8Array, romName: string) {
		flushSRAM(module);
		flushFlash(module);
		module._powerOff();
		module._powerOn();
		module._clearAudioSamples();
		lastTime = 0; cycleAccum = 0;
		paused = false; autoPaused = false;
		currentRomName = romName;
		currentRomData = data;
		powered = true;
		module._resume();
		loadROM(module, data);
		container?.focus();
		clearTimeout(cursorTimer);
		cursorHidden = false;
		cursorTimer = window.setTimeout(() => { cursorHidden = true; }, 3000);
	}

	async function bootZipEntry(entry: ZipEntry) {
		if (!nes) { return; }
		showZipChooser = false;
		let nesBasename = entry.path.split('/').pop() ?? entry.path;
		let romName = zipStemName + '-' + nesBasename.replace(/\.nes$/i, '');
		await bootRomEntry(nes, entry.data, romName);
	}

	async function loadGame(file: File) {
		if (!nes) { return; }
		try {
			if (file.name.endsWith('.zip')) {
				let rawZip = new Uint8Array(await file.arrayBuffer());
				let zip = unzipSync(rawZip, { filter: isVisibleNesFile });
				let entries = Object.entries(zip) as [string, Uint8Array][];
				if (entries.length === 0) { return; }
				cachedZipData = rawZip;
				cachedZipName = file.name;
				if (entries.length === 1) {
					let zipStem = file.name.slice(0, -4);
					let nesBasename = entries[0][0].split('/').pop() ?? entries[0][0];
					let romName = zipStem + '-' + nesBasename.replace(/\.nes$/i, '');
					await bootRomEntry(nes, entries[0][1], romName);
				} else {
					openZipChooser(file.name, entries);
				}
			} else {
				cachedZipData = null;
				cachedZipName = null;
				let data = new Uint8Array(await file.arrayBuffer());
				let romName = file.name.replace(/\.nes$/i, '');
				await bootRomEntry(nes, data, romName);
			}
		} catch (err) {
			console.error('[NESScreen] ROM load failed:', err);
		}
	}

	function restoreSaves(module: NESModule) {
		const sramSave = localStorage.getItem(`nesplayer-${currentRomName}.sram`);
		if (sramSave && module._hasBattery()) {
			const bytes = Uint8Array.from(atob(sramSave), c => c.charCodeAt(0));
			module.HEAPU8.set(bytes, module._getSRAMPtr());
		}
		const flashSave = localStorage.getItem(`nesplayer-${currentRomName}.flash`);
		if (flashSave) {
			const bytes = Uint8Array.from(atob(flashSave), c => c.charCodeAt(0));
			const ptr   = module._getPRGRomPtr();
			if (ptr && bytes.length <= module._getPRGRomSize()) {
				module.HEAPU8.set(bytes, ptr);
			}
		}
		const stateSave = localStorage.getItem(`nesplayer-${currentRomName}.state`);
		quickSaveState  = stateSave ? Uint8Array.from(atob(stateSave), c => c.charCodeAt(0)) : null;
	}

	function flushSRAM(module: NESModule) {
		if (!module._hasBattery() || !module._getSRAMDirty()) {
			return;
		}
		const ptr  = module._getSRAMPtr();
		const size = module._getSRAMSize();
		const data = module.HEAPU8.slice(ptr, ptr + size);
		localStorage.setItem(`nesplayer-${currentRomName}.sram`, btoa(String.fromCharCode(...data)));
		module._clearSRAMDirty();
	}

	function flushFlash(module: NESModule) {
		if (!module._getFlashDirty()) {
			return;
		}
		const ptr  = module._getPRGRomPtr();
		const size = module._getPRGRomSize();
		const data = module.HEAPU8.slice(ptr, ptr + size);
		localStorage.setItem(`nesplayer-${currentRomName}.flash`, btoa(String.fromCharCode(...data)));
		module._clearFlashDirty();
	}

	function loadROM(module: NESModule, data: Uint8Array) {
		const ptr    = module._malloc(data.length);
		module.HEAPU8.set(data, ptr);
		const result = module._loadNESROM(ptr, data.length);
		module._free(ptr);
		if (result !== 0) {
			throw new Error(`loadNESROM failed (${result})`);
		}
		restoreSaves(module);
		autoRegion = module._getRegion();
		if (userRegion === 'ntsc') { module._setRegion(0); }
		else if (userRegion === 'pal') { module._setRegion(1); }
		module._setAudioSampleRate(sampleRate);
	}

	function createShader(g: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
		const shader = g.createShader(type);
		if (!shader) {
			return null;
		}
		g.shaderSource(shader, src);
		g.compileShader(shader);
		if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) {
			console.error('[NESScreen] Shader error:', g.getShaderInfoLog(shader));
			g.deleteShader(shader);
			return null;
		}
		return shader;
	}

	function initWebGL(c: HTMLCanvasElement): boolean {
		gl = c.getContext('webgl', { alpha: false, antialias: false });
		if (!gl) {
			return false;
		}

		const vs = createShader(gl, gl.VERTEX_SHADER,   VERT_SRC);
		const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
		if (!vs || !fs) {
			return false;
		}

		const prog = gl.createProgram();
		if (!prog) {
			return false;
		}
		gl.attachShader(prog, vs);
		gl.attachShader(prog, fs);
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			console.error('[NESScreen] Program link error:', gl.getProgramInfoLog(prog));
			return false;
		}
		program = prog;

		posBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

		texBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,1, 1,1, 0,0, 1,0]), gl.STATIC_DRAW);

		texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

		return true;
	}

	async function initAudio(module: NESModule) {
		if (typeof SharedArrayBuffer === 'undefined') {
			console.warn('[NESScreen] SharedArrayBuffer unavailable — audio disabled. Serve with COOP/COEP headers to enable.');
			return;
		}
		if (!audioCtx) {
			audioCtx = new AudioContext({ sampleRate });
		}
		console.log('[NESScreen] AudioContext state:', audioCtx.state, 'sampleRate:', audioCtx.sampleRate);
		void audioCtx.resume();

		const workletBlob = new Blob([audioWorkletSrc], { type: 'text/javascript' });
		const workletUrl  = URL.createObjectURL(workletBlob);
		await audioCtx.audioWorklet.addModule(workletUrl);
		URL.revokeObjectURL(workletUrl);

		const workletNode = new AudioWorkletNode(audioCtx, 'nes-audio-processor', {
			numberOfInputs:     0,
			numberOfOutputs:    1,
			outputChannelCount: [2],
		});
		gainNode = audioCtx.createGain();
		gainNode.gain.value = muted ? 0 : volume;
		workletNode.connect(gainNode);
		gainNode.connect(audioCtx.destination);

		const sab  = new SharedArrayBuffer(8 + RING_SIZE * 4);
		headerView = new Int32Array(sab, 0, 2);
		ringView   = new Float32Array(sab, 8, RING_SIZE);
		workletNode.port.postMessage({ type: 'init', sharedBuffer: sab });

		module._setAudioSampleRate(sampleRate);
		console.log('[NESScreen] Audio init complete. sampleCount after rate set:', module._getAudioSampleCount());
	}

	function fitCanvas() {
		if (!container || !canvas) {
			return;
		}
		const cw = container.clientWidth;
		const ch = container.clientHeight;
		const ar = cw / ch;
		let w: number, h: number;
		if (ar > ASPECT) {
			h = ch;
			w = Math.round(ch * ASPECT);
		} else {
			w = cw;
			h = Math.round(cw / ASPECT);
		}
		canvas.style.width  = `${w}px`;
		canvas.style.height = `${h}px`;
		const dpr = window.devicePixelRatio || 1;
		canvas.width  = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		overlayTop  = Math.round((ch - h) / 2);
		overlayH    = h;
		overlayLeft = Math.round((cw - w) / 2);
		overlayW    = w;

		if (nes && powered) {
			drawFrame(nes);
		}
	}

	function drawFrame(module: NESModule) {
		if (!gl || !texture || !program || !posBuf || !texBuf) {
			return;
		}
		const ptr      = module._getFramebufferPtr();
		const framebuf = module.HEAPU8.subarray(ptr, ptr + SCREEN_W * SCREEN_H * 4);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SCREEN_W, SCREEN_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, framebuf);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, canvas!.width, canvas!.height);
		gl.useProgram(program);

		const posLoc = gl.getAttribLocation(program, 'a_position');
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
		gl.enableVertexAttribArray(posLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

		const texLoc = gl.getAttribLocation(program, 'a_texCoord');
		gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
		gl.enableVertexAttribArray(texLoc);
		gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function drawStatic() {
		if (!gl || !texture || !program || !posBuf || !texBuf) {
			return;
		}
		for (let i = 0; i < staticBuf.length; i += 4) {
			const v = Math.random() * 255 | 0;
			staticBuf[i]     = v;
			staticBuf[i + 1] = v;
			staticBuf[i + 2] = v;
			staticBuf[i + 3] = 255;
		}
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SCREEN_W, SCREEN_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, staticBuf);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, canvas!.width, canvas!.height);
		gl.useProgram(program);
		const posLoc = gl.getAttribLocation(program, 'a_position');
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
		gl.enableVertexAttribArray(posLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
		const texLoc = gl.getAttribLocation(program, 'a_texCoord');
		gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
		gl.enableVertexAttribArray(texLoc);
		gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function runFrame(currentTime: number) {
		animId = requestAnimationFrame(runFrame);

		const module = nes;
		if (!module) {
			return;
		}

		const livePads = [...navigator.getGamepads()];

		module._setButtons(0, pollPlayer(player1Input, player1KeyMap));
		module._setButtons(1, pollPlayer(player2Input, player2KeyMap));

		for (const inp of [player1Input, player2Input]) {
			if (inp.type !== 'gamepad') { continue; }
			const pad  = livePads.find(p => p?.connected && p.id === inp.id) ?? null;
			if (!pad) { continue; }
			const prof     = gamepadProfiles.find(p => p.id === inp.id);
			const saveBtn  = prof?.quickSaveBtn ?? null;
			const loadBtn  = prof?.quickLoadBtn ?? null;
			if (saveBtn !== null && saveBtn !== undefined) {
				const now = pad.buttons[saveBtn]?.pressed ?? false;
				if (now && !gpQsSavePrev[inp.id]) { quickSave(); }
				gpQsSavePrev[inp.id] = now;
			}
			if (loadBtn !== null && loadBtn !== undefined) {
				const now = pad.buttons[loadBtn]?.pressed ?? false;
				if (now && !gpQsLoadPrev[inp.id]) { quickLoad(); }
				gpQsLoadPrev[inp.id] = now;
			}
		}

		if (module._isPaused()) {
			if (powered && !currentRomData) {
				drawStatic();
			}
			lastTime   = 0;
			cycleAccum = 0;
			return;
		}

		if (!currentRomData) {
			drawStatic();
			return;
		}

		if (lastTime === 0) {
			lastTime = currentTime;
		}
		const elapsed = (currentTime - lastTime) / 1000;
		lastTime = currentTime;
		cycleAccum += Math.min(elapsed, 1 / 15) * module._getCPUHz();

		const cpf = module._getCyclesPerFrame();
		if (cycleAccum < cpf) {
			return;
		}

		let framesRun = 0;
		while (cycleAccum >= cpf && framesRun < 4) {
			const executed = module._tickFrame(cpf);
			cycleAccum -= executed;
			framesRun++;
			if (headerView) {
				const samples = getAudioSamples(module);
				if (samples.length > 0) {
					pushSamples(samples);
				}
			} else {
				module._clearAudioSamples();
			}
		}

		if (module._getSRAMDirty()) {
			flushSRAM(module);
		}
		if (module._getFlashDirty()) {
			flushFlash(module);
		}

		drawFrame(module);
	}

	$effect(() => {
		if (!nes || !rom) {
			return;
		}
		currentRomName = romName ?? '';
		currentRomData = rom;
		lastTime       = 0;
		cycleAccum     = 0;
		paused         = false;
		autoPaused     = false;
		powered        = true;
		nes._resume();
		loadROM(nes, rom);
	});

	$effect(() => {
		const gain = muted ? 0 : volume;
		if (!gainNode) {
			return;
		}
		gainNode.gain.value = gain;
	});

	$effect(() => {
		if (!nes || !audioCtx || audioCtx.sampleRate === sampleRate) {
			return;
		}
		headerView = null;
		ringView   = null;
		gainNode   = null;
		const old = audioCtx;
		audioCtx  = null;
		void (async () => {
			await old.close();
			await initAudio(nes!);
		})();
	});

	$effect(() => {
		if (showZipChooser && zipChooserList) {
			let el = zipChooserList.children[zipEntryIndex] as HTMLElement | undefined;
			el?.scrollIntoView({ block: 'nearest' });
		}
	});

	$effect(() => {
		if (!configLoaded) { return; }
		localStorage.setItem(INPUT_CONFIG_KEY, JSON.stringify({
			player1Input, player2Input, player1KeyMap, player2KeyMap, gamepadProfiles,
			quickSaveKey, quickLoadKey,
		}));
	});

	$effect(() => {
		if (!nes || !powered) { return; }
		if (showControllerPanel) {
			if (!paused && !autoPaused) {
				nes._pause();
				autoPaused               = true;
				controllerPanelAutoPaused = true;
			}
		} else if (controllerPanelAutoPaused) {
			nes._resume();
			autoPaused               = false;
			controllerPanelAutoPaused = false;
		}
	});

	function clearScreen() {
		if (!gl) {
			return;
		}
		gl.clearColor(0, 0, 0, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
	}

	async function onPower() {
		if (!nes) { return; }
		if (powered) {
			flushSRAM(nes);
			flushFlash(nes);
			nes._powerOff();
			nes._pause();
			nes._clearAudioSamples();
			lastTime   = 0;
			cycleAccum = 0;
			clearScreen();
			powered = false;
			paused  = false;
		} else if (cachedZipData && cachedZipName) {
			let zip = unzipSync(cachedZipData, { filter: isVisibleNesFile });
			let entries = Object.entries(zip) as [string, Uint8Array][];
			if (entries.length === 1) {
				let zipStem = cachedZipName.endsWith('.zip') ? cachedZipName.slice(0, -4) : cachedZipName;
				let nesBasename = entries[0][0].split('/').pop() ?? entries[0][0];
				let romName = zipStem + '-' + nesBasename.replace(/\.nes$/i, '');
				await bootRomEntry(nes, entries[0][1], romName);
			} else if (entries.length > 1) {
				openZipChooser(cachedZipName, entries);
			}
		} else if (currentRomData) {
			await bootRomEntry(nes, currentRomData, currentRomName);
		} else {
			nes._powerOn();
			nes._resume();
			lastTime = 0; cycleAccum = 0;
			powered = true;
		}
	}

	function onPauseToggle() {
		if (!nes) { return; }
		if (paused || autoPaused) {
			nes._resume();
			paused     = false;
			autoPaused = false;
		} else {
			nes._pause();
			paused = true;
		}
	}

	function onReset() {
		if (!nes) { return; }
		nes._reset();
		nes._resume();
		lastTime   = 0;
		cycleAccum = 0;
		paused     = false;
		autoPaused = false;
	}

	function onRegionToggle() {
		userRegion = userRegion === 'auto' ? 'ntsc' : userRegion === 'ntsc' ? 'pal' : 'auto';
		if (!nes || !powered) { return; }
		const r = userRegion === 'pal' ? 1 : userRegion === 'ntsc' ? 0 : autoRegion;
		nes._reset();
		nes._setRegion(r);
		nes._setAudioSampleRate(sampleRate);
		lastTime   = 0;
		cycleAccum = 0;
		paused     = false;
	}

	function onFullscreenToggle() {
		if (!document.fullscreenElement) {
			container?.requestFullscreen();
		} else {
			document.exitFullscreen();
		}
	}

	function onVolumeInput(e: Event) {
		const val = parseFloat((e.target as HTMLInputElement).value);
		volume = val;
		if (val > 0) {
			muted = false;
		}
	}

	function onMuteToggle() {
		muted = !muted;
	}

	async function onInsertRomClick(e: MouseEvent) {
		(e.currentTarget as HTMLButtonElement).blur();
		if ('showOpenFilePicker' in window) {
			let wasRunning = powered && !paused && !autoPaused;
			if (wasRunning) { nes?._pause(); autoPaused = true; }
			try {
				let opts: any = {
					types: [{ description: 'NES ROMs', accept: { 'application/octet-stream': ['.nes', '.zip'] } }],
					multiple: false,
				};
				if (lastPickHandle) { opts.startIn = lastPickHandle; }
				let [handle] = await (window as any).showOpenFilePicker(opts);
				lastPickHandle = handle;
				await loadGame(await handle.getFile());
			} catch (err: any) {
				if (err.name !== 'AbortError') { console.error('[NESScreen] File picker error:', err); }
				else if (wasRunning) { nes?._resume(); autoPaused = false; }
			}
		} else {
			fileInput?.click();
		}
	}

	async function onFileChange(e: Event) {
		let file = (e.target as HTMLInputElement).files?.[0];
		if (file) { await loadGame(file); }
		(e.target as HTMLInputElement).value = '';
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dropTarget = false;
		let file = Array.from(e.dataTransfer?.files ?? []).find(f => f.name.endsWith('.nes') || f.name.endsWith('.zip'));
		if (file) { await loadGame(file); }
	}

	onMount(() => {
		loadInputConfig();
		configLoaded = true;

		const onKeyDown = (e: KeyboardEvent) => {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA') { return; }
			if (e.code === quickSaveKey) { e.preventDefault(); quickSave(); return; }
			if (e.code === quickLoadKey) { e.preventDefault(); quickLoad(); return; }
			if (showControllerPanel) { return; }
			held.add(e.code);
			if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
				e.preventDefault();
			}
		};
		const onKeyUp = (e: KeyboardEvent) => {
			held.delete(e.code);
		};
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup',   onKeyUp);

		const ro = new ResizeObserver(() => fitCanvas());
		if (container) {
			ro.observe(container);
		}

		const onUnload = () => {
			if (nes) {
				flushSRAM(nes);
				flushFlash(nes);
			}
		};
		window.addEventListener('beforeunload', onUnload);

		if (typeof SharedArrayBuffer !== 'undefined') {
			audioCtx = new AudioContext({ sampleRate });
			void audioCtx.resume();
		}

		const resumeCtx = () => {
			if (audioCtx?.state === 'suspended') {
				void audioCtx.resume();
			}
		};
		document.addEventListener('click',       resumeCtx);
		document.addEventListener('keydown',     resumeCtx);
		document.addEventListener('pointerdown', resumeCtx);

		const onFullscreenChange = () => { isFullscreen = !!document.fullscreenElement; };
		document.addEventListener('fullscreenchange', onFullscreenChange);

		function applyAutoAssign(id: string) {
			if (id === savedP1GamepadId && player1Input.type !== 'gamepad') {
				player1Input = { type: 'gamepad', id };
			} else if (id === savedP2GamepadId && player2Input.type !== 'gamepad') {
				player2Input = { type: 'gamepad', id };
			}
		}

		function handlePadConnect(gp: Gamepad) {
			if (detectedGamepads.some(p => p.id === gp.id)) { return; }
			detectedGamepads = [...detectedGamepads, padInfo(gp)];
			const revertPlayer = autoRevertPads[gp.id];
			if (revertPlayer !== undefined) {
				const { [gp.id]: _, ...rest } = autoRevertPads;
				autoRevertPads = rest;
				if (revertPlayer === 1) { player1Input = { type: 'gamepad', id: gp.id }; }
				else                    { player2Input = { type: 'gamepad', id: gp.id }; }
			} else {
				applyAutoAssign(gp.id);
			}
		}

		function handlePadDisconnect(id: string) {
			if (!detectedGamepads.some(p => p.id === id)) { return; }
			detectedGamepads = detectedGamepads.filter(p => p.id !== id);
			if (player1Input.type === 'gamepad' && player1Input.id === id) {
				autoRevertPads = { ...autoRevertPads, [id]: 1 };
				player1Input = { type: 'keyboard' };
			} else if (player2Input.type === 'gamepad' && player2Input.id === id) {
				autoRevertPads = { ...autoRevertPads, [id]: 2 };
				player2Input = { type: 'keyboard' };
			}
		}

		function syncGamepads() {
			const current = [...navigator.getGamepads()].filter(Boolean) as Gamepad[];
			for (const gp of current) {
				handlePadConnect(gp);
			}
			for (const known of [...detectedGamepads]) {
				if (!current.some(gp => gp.id === known.id)) {
					handlePadDisconnect(known.id);
				}
			}
		}
		syncGamepads();
		const padPollInterval = setInterval(syncGamepads, 500);

		const onGamepadConnected    = () => syncGamepads();
		const onGamepadDisconnected = () => syncGamepads();
		window.addEventListener('gamepadconnected',    onGamepadConnected);
		window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

		void (async () => {
			const module  = await createNESPlayerModule({}) as NESModule;
			module._init();
			module._powerOn();
			await initAudio(module);
			nes = module;
			if (canvas && initWebGL(canvas)) {
				fitCanvas();
				animId = requestAnimationFrame(runFrame);
			}
		})();

		return () => {
			cancelAnimationFrame(animId);
			if (nes) {
				flushSRAM(nes);
				flushFlash(nes);
				nes._powerOff();
			}
			void audioCtx?.close();
			ro.disconnect();
			window.removeEventListener('keydown',      onKeyDown);
			window.removeEventListener('keyup',        onKeyUp);
			window.removeEventListener('beforeunload', onUnload);
			held.clear();
			document.removeEventListener('click',            resumeCtx);
			document.removeEventListener('keydown',          resumeCtx);
			document.removeEventListener('pointerdown',      resumeCtx);
			document.removeEventListener('fullscreenchange', onFullscreenChange);
			clearInterval(padPollInterval);
			window.removeEventListener('gamepadconnected',    onGamepadConnected);
			window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
		};
	});
</script>

<svelte:window onkeydown={(e) => {
	if (!showZipChooser) { return; }
	if (e.code === 'ArrowUp')   { e.preventDefault(); zipEntryIndex = Math.max(0, zipEntryIndex - 1); }
	else if (e.code === 'ArrowDown')  { e.preventDefault(); zipEntryIndex = Math.min(zipEntries.length - 1, zipEntryIndex + 1); }
	else if (e.code === 'Enter')      { void bootZipEntry(zipEntries[zipEntryIndex]); }
	else if (e.code === 'Escape')     { showZipChooser = false; }
}} />

<div
	bind:this={container}
	class="nes-screen"
	class:drop-target={dropTarget}
	class:cursor-hidden={cursorHidden}
	role="application"
	aria-label="NES emulator"
	tabindex="-1"
	onpointerdown={onContainerPointerDown}
	ondblclick={onContainerDblClick}
	onmousemove={onContainerMouseMove}
	onmouseleave={onContainerMouseLeave}
	onfocusin={onContainerFocusIn}
	onfocusout={onContainerFocusOut}
	ondragover={(e) => { if (Array.from(e.dataTransfer?.items ?? []).some(i => i.kind === 'file')) { e.preventDefault(); dropTarget = true; } }}
	ondragleave={(e) => { if (!e.relatedTarget || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) { dropTarget = false; } }}
	ondrop={handleDrop}
>
	<canvas bind:this={canvas}></canvas>

	{#if (paused || autoPaused) && powered}
		<div
			class="pause-overlay"
			style="top: {overlayTop}px; left: {overlayLeft}px; width: {overlayW}px; height: {overlayH}px;"
		>
			Paused
		</div>
	{/if}

	<div class="overlay-zone" class:visible={showOverlay} style="top: {overlayTop}px; right: {overlayLeft}px; height: {overlayH}px;">
		<div
			class="overlay-panel"
			role="toolbar"
			aria-label="Emulator controls"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			ondblclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>

			<button class="overlay-btn" class:powered aria-label={powered ? 'Power off' : 'Power on'} data-tip={powered ? 'Power off' : 'Power on'} onclick={onPower}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 2v6"/>
					<path d="M6.4 5.4a8 8 0 1 0 11.2 0"/>
				</svg>
			</button>

			<button class="overlay-btn" class:active={paused || autoPaused} aria-label={(paused || autoPaused) ? 'Resume' : 'Pause'} data-tip={(paused || autoPaused) ? 'Resume' : 'Pause'} onclick={onPauseToggle}>
				{#if paused || autoPaused}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="5 3 19 12 5 21 5 3"/>
					</svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="6" y="4" width="4" height="16"/>
						<rect x="14" y="4" width="4" height="16"/>
					</svg>
				{/if}
			</button>

			<button class="overlay-btn" aria-label="Reset" data-tip="Reset" onclick={onReset}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
					<path d="M3 3v5h5"/>
				</svg>
			</button>

			<div class="slider-wrap">
				<input
					type="range"
					class="vol-slider"
					min="0" max="1" step="0.01"
					value={muted ? 0 : volume}
					oninput={onVolumeInput}
				/>
			</div>

			<button class="overlay-btn" class:active={muted} aria-label={muted ? 'Unmute' : 'Mute'} data-tip={muted ? 'Unmute' : 'Mute'} onclick={onMuteToggle}>
				{#if muted}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
						<line x1="23" y1="9" x2="17" y2="15"/>
						<line x1="17" y1="9" x2="23" y2="15"/>
					</svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
						<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
					</svg>
				{/if}
			</button>

			<button class="overlay-btn" aria-label="Insert ROM" data-tip="Insert ROM" onclick={onInsertRomClick}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M4 3H20V19H18V21H6V19H4Z"/>
					<path d="M6 3V12H18V3"/>
					<line x1="6" y1="6" x2="18" y2="6"/>
				</svg>
			</button>
			<input bind:this={fileInput} type="file" accept=".nes,.zip" style="display:none" onchange={onFileChange} />

			<button class="overlay-btn" class:active={showControllerPanel} aria-label="Controllers" data-tip="Controllers" onclick={() => { showControllerPanel = !showControllerPanel; }}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="6" y1="12" x2="10" y2="12"/>
					<line x1="8" y1="10" x2="8" y2="14"/>
					<circle cx="15" cy="13" r="0.5" fill="currentColor"/>
					<circle cx="18" cy="11" r="0.5" fill="currentColor"/>
					<rect x="2" y="6" width="20" height="12" rx="2"/>
				</svg>
			</button>

			<button class="overlay-btn overlay-btn--region" data-tip="Toggle region (Auto / NTSC / PAL)" onclick={onRegionToggle}>
				{userRegion === 'ntsc' ? 'NTSC' : userRegion === 'pal' ? 'PAL' : 'Auto'}
			</button>

			<button class="overlay-btn" aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} data-tip={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onclick={onFullscreenToggle}>
				{#if isFullscreen}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M8 3v3a2 2 0 0 1-2 2H3"/>
						<path d="M21 8h-3a2 2 0 0 1-2-2V3"/>
						<path d="M3 16h3a2 2 0 0 1 2 2v3"/>
						<path d="M16 21v-3a2 2 0 0 1 2-2h3"/>
					</svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M3 7V5a2 2 0 0 1 2-2h2"/>
						<path d="M17 3h2a2 2 0 0 1 2 2v2"/>
						<path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
						<path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
					</svg>
				{/if}
			</button>

		</div>
	</div>

	{#if showZipChooser}
		<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
		<div class="zip-chooser-overlay" role="presentation" onclick={() => { showZipChooser = false; }}>
			<div class="zip-chooser" role="presentation" onclick={(e) => { e.stopPropagation(); }}>
				<div class="zip-chooser-title">SELECT GAME</div>
				<div class="zip-chooser-filename">{zipStemName}.zip</div>
				<div class="zip-chooser-list" bind:this={zipChooserList} role="listbox">
					{#each zipEntries as entry, i (entry.path)}
						<button
							class="zip-chooser-item"
							class:selected={zipEntryIndex === i}
							role="option"
							aria-selected={zipEntryIndex === i}
							onmouseenter={() => { zipEntryIndex = i; }}
							onclick={() => { void bootZipEntry(entry); }}
						>
							<span class="zip-chooser-arrow">{zipEntryIndex === i ? '▶' : ''}</span>
							{entry.path.split('/').pop() ?? entry.path}
						</button>
					{/each}
				</div>
				<div class="zip-chooser-hint">▲▼ SELECT &nbsp;&nbsp; ENTER PLAY &nbsp;&nbsp; ESC CANCEL</div>
			</div>
		</div>
	{/if}

	{#if stateMessage}
		<div
			class="state-toast"
			style="top: {overlayTop + overlayH - 40}px; left: {overlayLeft}px; width: {overlayW}px;"
		>
			{stateMessage}
		</div>
	{/if}

	<div
		class="version-badge"
		class:visible={showOverlay}
		style="top: {overlayTop + overlayH - 24}px; left: {overlayLeft + 8}px;"
	>
		NES Player (Svelte) v{version}
	</div>

	{#if showControllerPanel}
		<ControllerPanel
			defaultKeyMap={DEFAULT_KEYMAP}
			defaultGamepadButtonMap={DEFAULT_GAMEPAD_BUTTON_MAP}
			{detectedGamepads}
			{gamepadProfiles}
			{player1Input}
			{player2Input}
			{player1KeyMap}
			{player2KeyMap}
			{quickSaveKey}
			{quickLoadKey}
			onquicksavekeychange={(k) => { quickSaveKey = k; }}
			onquickloadkeychange={(k) => { quickLoadKey = k; }}
			onplayer1inputchange={(v) => { player1Input = v; }}
			onplayer2inputchange={(v) => { player2Input = v; }}
			onplayer1keymapchange={(m) => { player1KeyMap = m; }}
			onplayer2keymapchange={(m) => { player2KeyMap = m; }}
			ongpprofilechange={(p) => {
				gamepadProfiles = [...gamepadProfiles.filter(x => x.id !== p.id), p];
			}}
			onclose={() => { showControllerPanel = false; }}
		/>
	{/if}
</div>

<style>
	.nes-screen {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: black;
		position: relative;
		outline: none;
	}

	.nes-screen.cursor-hidden,
	.nes-screen.cursor-hidden * {
		cursor: none !important;
	}

	.pause-overlay {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.45);
		color: rgba(255, 255, 255, 0.9);
		font-size: 1.5rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		pointer-events: none;
	}

	.overlay-zone {
		position: absolute;
		width: 52px;
		pointer-events: none;
	}

	.overlay-zone.visible {
		pointer-events: auto;
	}

	.overlay-panel {
		position: absolute;
		inset: 0;
		box-sizing: border-box;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 6px 0;
		gap: 4px;
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	.overlay-zone.visible .overlay-panel {
		opacity: 1;
	}

	.overlay-btn {
		width: 36px;
		height: 36px;
		min-height: 0;
		border: none;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.85);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	.overlay-btn:hover {
		background: rgba(255, 255, 255, 0.25);
	}

	.overlay-btn.active {
		color: #f87171;
	}

	.overlay-btn.powered {
		color: #4ade80;
	}

	.overlay-btn--region {
		font-size: 0.6rem;
		font-weight: 700;
		letter-spacing: 0.05em;
	}

	.overlay-btn[data-tip] {
		position: relative;
	}

	.overlay-btn[data-tip]::after {
		content: attr(data-tip);
		position: absolute;
		right: calc(100% + 8px);
		top: 50%;
		transform: translateY(-50%);
		background: rgba(0, 0, 0, 0.85);
		color: rgba(255, 255, 255, 0.9);
		font-size: 0.68rem;
		font-weight: 500;
		padding: 3px 8px;
		border-radius: 4px;
		white-space: nowrap;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.12s ease 0s;
	}

	.overlay-btn[data-tip]:hover::after {
		opacity: 1;
		transition-delay: 0.5s;
	}


	.slider-wrap {
		flex: 1;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		min-height: 0;
	}

	.vol-slider {
		writing-mode: vertical-lr;
		direction: rtl;
		width: 32px;
		height: 100%;
		cursor: pointer;
		accent-color: rgba(255, 255, 255, 0.85);
	}

	.state-toast {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		height: 32px;
		background: rgba(0, 0, 0, 0.72);
		color: rgba(255, 255, 255, 0.88);
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		pointer-events: none;
		z-index: 10;
		animation: toast-fade 1.5s ease forwards;
	}

	@keyframes toast-fade {
		0%   { opacity: 1; }
		60%  { opacity: 1; }
		100% { opacity: 0; }
	}

	.version-badge {
		position: absolute;
		height: 20px;
		padding: 0 8px;
		display: flex;
		align-items: center;
		background: rgba(0, 0, 0, 0.5);
		color: rgba(255, 255, 255, 0.38);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.07em;
		border-radius: 4px;
		pointer-events: none;
		z-index: 10;
		opacity: 0;
		transition: opacity 0.18s ease;
	}

	.version-badge.visible {
		opacity: 1;
	}

	.drop-target {
		outline: 2px dashed rgba(255, 255, 255, 0.4);
		outline-offset: -4px;
	}

	.zip-chooser-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 4, 0.97);
		z-index: 20;
		cursor: pointer;
	}

	.zip-chooser {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		width: min(94%, 640px);
		max-height: 84%;
		background: #000070;
		border: 3px solid #f8f8f8;
		outline: 3px solid #f8f8f8;
		outline-offset: 5px;
		padding: 28px 32px 22px;
		font-family: 'Press Start 2P', monospace;
		color: #f8f8f8;
		cursor: default;
	}

	.zip-chooser-title {
		font-size: 22px;
		color: #fcfc00;
		text-align: center;
		text-transform: uppercase;
		margin-bottom: 14px;
		line-height: 1.5;
	}

	.zip-chooser-filename {
		font-size: 11px;
		color: #a0a0fc;
		text-align: center;
		margin-bottom: 22px;
		line-height: 1.8;
		word-break: break-all;
	}

	.zip-chooser-list {
		width: 100%;
		flex: 1;
		overflow-y: auto;
		scrollbar-width: none;
		margin-bottom: 18px;
		min-height: 0;
	}

	.zip-chooser-list::-webkit-scrollbar {
		display: none;
	}

	.zip-chooser-item {
		appearance: none;
		-webkit-appearance: none;
		background: none;
		border: none;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
		width: 100%;
		text-align: left;
		font-size: 15px;
		padding: 10px 2px;
		cursor: pointer;
		color: #9090c0;
		display: flex;
		align-items: center;
		gap: 14px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.zip-chooser-item:last-child {
		border-bottom: none;
	}

	.zip-chooser-item.selected {
		color: #fcfcfc;
	}

	.zip-chooser-item:hover:not(.selected) {
		color: #c8c8f0;
	}

	.zip-chooser-arrow {
		width: 16px;
		flex-shrink: 0;
		color: #fcfc00;
		font-size: 14px;
	}

	@keyframes nes-blink {
		0%, 49% { opacity: 1; }
		50%, 100% { opacity: 0; }
	}

	.zip-chooser-item.selected .zip-chooser-arrow {
		animation: nes-blink 0.7s step-end infinite;
	}

	.zip-chooser-hint {
		font-size: 11px;
		color: #5050c0;
		text-transform: uppercase;
		text-align: center;
		border-top: 1px solid rgba(255, 255, 255, 0.18);
		padding-top: 14px;
		line-height: 2;
	}
</style>
