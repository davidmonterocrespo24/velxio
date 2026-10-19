/**
 * Interactive ngspice worker — vendored + extended from
 * `ejkreboot/ngspice-xspice-wasm` (MIT, 2026). The original repo provides
 * a batch-only client; we vendor the WASM build as-is and add new message
 * types for mixed-mode (event-driven) coupling between an MCU simulator
 * and the analog SPICE solver.
 *
 * Original batch API (preserved for backward-compat with non-interactive
 * callers):
 *   'init', 'run', 'reset'
 *
 * New interactive message types (Phase 1a of the mixed-mode simulator
 * roadmap — see `project/sim-mixedmode/phase-01-mixed-mode-coupling.md`
 * in the velxio-prod repo):
 *   'loadNetlist' — send a netlist to ngspice without running yet
 *                   (so subsequent commands can drive analysis manually)
 *   'command'     — send a raw ngspice command string and return stdout
 *                   captured during its execution (`alter`, `tran`,
 *                   `display`, etc.)
 *   'readVec'     — read a vector's current value(s) by name
 *
 * Not yet implemented (Phase 1b — needs investigation of single-thread
 * WASM workarounds for ngspice background mode):
 *   'bgRun', 'bgHalt', 'bgResume' — true continuation across alter calls.
 *   Current workaround at the client level: chain `tran` invocations
 *   with shrinking dt, each one alter-ing the source from the previous
 *   state. See NgSpiceInteractive.ts for the workaround impl.
 */

const MODEL_FILES = [
	'analog.cm',
	'digital.cm',
	'spice2poly.cm',
	'table.cm',
	'tlines.cm',
	'xtradev.cm',
	'xtraevt.cm',
];

// vecvaluesall struct offsets (used by onData callback during simulation)
const VECVALUESALL_COUNT_OFFSET = 0;
const VECVALUESALL_VALUES_OFFSET = 8;
const VECVALUES_NAME_OFFSET = 0;
const VECVALUES_REAL_OFFSET = 8;
const VECVALUES_IS_SCALE_OFFSET = 24;

// vector_info struct offsets (used for post-simulation data extraction)
const VECTOR_INFO_NAME_OFFSET = 0;
const VECTOR_INFO_TYPE_OFFSET = 4;
const VECTOR_INFO_FLAGS_OFFSET = 8;
const VECTOR_INFO_REALDATA_OFFSET = 12;
const VECTOR_INFO_IMAGDATA_OFFSET = 16;
const VECTOR_INFO_LENGTH_OFFSET = 20;

// vecinfoall struct offsets (used by onDataInit callback)
const VECINFOALL_COUNT_OFFSET = 16;
const VECINFOALL_VECS_OFFSET = 20;
const VECINFO_NAME_OFFSET = 4;

// ngspice vector type flag for complex data
const VF_COMPLEX = 0x400;

// Analysis types that produce scalar results (no sweep)
const SCALAR_ANALYSIS_TYPES = new Set(['op', 'tf', 'sens']);

let moduleConfig = null;
let moduleReady = null;
let filesystemReady = false;
let api = null;
let callbackPointers = null;
let ngspiceInitialized = false;
let currentRun = null;

function postDebug(event, details = {}) {
	self.postMessage({
		type: 'debug',
		requestId: currentRun?.requestId,
		event,
		details,
	});
}

self.addEventListener('message', async (event) => {
	const data = event.data || {};

	try {
		// ── Original batch API (preserved) ──────────────────────────────
		if (data.type === 'init') {
			await ensureSession(data.config || {});
			self.postMessage({ type: 'ready', requestId: data.requestId });
			return;
		}

		if (data.type === 'run') {
			await runSimulation(data.requestId, data.netlist || '');
			return;
		}

		if (data.type === 'reset') {
			resetNgspice();
			self.postMessage({ type: 'reset-done', requestId: data.requestId });
			return;
		}

		// ── New interactive API (Phase 1a) ──────────────────────────────
		if (data.type === 'loadNetlist') {
			await handleLoadNetlist(data.requestId, data.netlist || '');
			return;
		}

		if (data.type === 'command') {
			handleCommand(data.requestId, data.command || '');
			return;
		}

		if (data.type === 'readVec') {
			handleReadVec(data.requestId, data.name || '');
			return;
		}

		if (data.type === 'readVecs') {
			handleReadVecs(data.requestId, Array.isArray(data.names) ? data.names : []);
			return;
		}

		if (data.type === 'solveState') {
			handleSolveState(data.requestId, data);
			return;
		}

		if (data.type === 'commands') {
			handleCommands(data.requestId, Array.isArray(data.commands) ? data.commands : []);
			return;
		}

		if (data.type === 'listVectors') {
			handleListVectors(data.requestId);
			return;
		}

		throw new Error(`Unknown message type: ${data.type}`);
	} catch (error) {
		self.postMessage({
			type: 'error',
			requestId: data.requestId,
			message: error instanceof Error ? error.message : String(error),
		});
	}
});

// ── Interactive handlers (Phase 1a) ─────────────────────────────────

/**
 * Load a netlist into ngspice without immediately running an analysis.
 * The netlist may include `.tran`, `.dc`, etc. directives that fire
 * automatically when ngspice processes them — or it may be purely
 * structural (components, sources, models) with analysis triggered
 * later via separate `command('tran ...')` calls.
 */
async function handleLoadNetlist(requestId, netlist) {
	if (!netlist.trim()) {
		throw new Error('Netlist is empty.');
	}
	resetNgspice();
	await ensureSession(moduleConfig || {});
	const lines = buildCircuitLines(netlist);
	const allocations = allocateCStringArray(lines);
	try {
		const rc = api.circ(allocations.arrayPointer);
		if (rc !== 0) {
			throw new Error(`ngSpice_Circ failed with status ${rc}.`);
		}
		self.postMessage({ type: 'loaded', requestId });
	} finally {
		freeCStringArray(allocations);
	}
}

/**
 * Send a raw command string to ngspice. Stdout / stderr lines captured
 * during the command's execution are buffered and returned in the
 * response, plus also emitted as 'stdout' / 'stderr' events (compatible
 * with the existing onPrint callback flow used by batch mode).
 */
function handleCommand(requestId, command) {
	if (!command.trim()) {
		throw new Error('Command is empty.');
	}
	const capture = beginCommandCapture(requestId);
	try {
		const t0 = performance.now();
		const rc = api.command(command);
		self.postMessage({
			type: 'command-result',
			requestId,
			rc,
			ms: performance.now() - t0,
			stdout: capture.stdout.slice(),
			stderr: capture.stderr.slice(),
		});
	} finally {
		endCommandCapture(capture);
	}
}

/**
 * Run several commands in order and answer once: the `alter`s that bring
 * the deck to a pad state before its solve. Each command's rc and output
 * come back in order; an empty command is skipped.
 */
function handleCommands(requestId, commands) {
	const results = [];
	for (const command of commands) {
		if (!String(command).trim()) continue;
		const capture = beginCommandCapture(requestId);
		try {
			const t0 = performance.now();
			const rc = api.command(String(command));
			results.push({ command, rc, ms: performance.now() - t0, stdout: capture.stdout.slice(), stderr: capture.stderr.slice() });
		} finally {
			endCommandCapture(capture);
		}
	}
	self.postMessage({ type: 'commands-result', requestId, results });
}

/**
 * Read several vectors in one message. A solve reads every net voltage
 * and branch current it publishes, a hundred vectors on a sixteen-LED
 * deck, and one message per vector made the reads cost more than the
 * solve: about 300 ms per operating point in the browser against 15 ms
 * for the engine. A vector that does not exist comes back with `error`
 * instead of failing the batch (a disconnected pin has none).
 */
function packVectors(names) {
	const t0 = performance.now();
	const entries = [];
	let total = 0;
	let anyImag = false;
	for (const name of names) {
		const infoPtr = api.getVecInfo(String(name));
		const data = infoPtr ? readVectorData(infoPtr, /* readImag */ true) : null;
		if (!data) {
			entries.push({ name, offset: -1, length: 0, data: null });
			continue;
		}
		entries.push({ name, offset: total, length: data.length, data });
		total += data.length;
		if (data.imag) anyImag = true;
	}
	const real = new Float64Array(total);
	const imag = anyImag ? new Float64Array(total) : null;
	const index = [];
	for (const e of entries) {
		if (e.data) {
			real.set(e.data.real, e.offset);
			if (imag && e.data.imag) imag.set(e.data.imag, e.offset);
		}
		index.push({ name: e.name, offset: e.offset, length: e.length, hasImag: !!(e.data && e.data.imag) });
	}
	const transferables = [real.buffer];
	if (imag) transferables.push(imag.buffer);
	return { index, real, imag, ms: performance.now() - t0, transferables };
}

function handleReadVecs(requestId, names) {
	const packed = packVectors(names);
	self.postMessage(
		{ type: 'vecs', requestId, index: packed.index, real: packed.real, imag: packed.imag, ms: packed.ms },
		packed.transferables,
	);
}

/**
 * One pad state, one message: the alters that bring the deck to it, the
 * analysis, and the packed read of every vector asked for. Each round trip
 * to the main thread waits behind whatever that thread is doing (an
 * engine frame, a paint), 50 to 70 ms while a simulation runs, against a
 * few milliseconds of engine work; three trips per state made a solve
 * cost two hundred milliseconds that the engine did in six.
 */
function handleSolveState(requestId, data) {
	const commands = Array.isArray(data.commands) ? data.commands : [];
	const names = Array.isArray(data.names) ? data.names : [];
	const alters = [];
	for (const command of commands) {
		if (!String(command).trim()) continue;
		const capture = beginCommandCapture(requestId);
		try {
			const t0 = performance.now();
			const rc = api.command(String(command));
			alters.push({ command, rc, ms: performance.now() - t0, stderr: capture.stderr.slice() });
		} finally {
			endCommandCapture(capture);
		}
	}
	const analysis = String(data.analysis || 'op');
	const capture = beginCommandCapture(requestId);
	let rc;
	let ms;
	let stdout;
	let stderr;
	try {
		const t0 = performance.now();
		rc = api.command(analysis);
		ms = performance.now() - t0;
		stdout = capture.stdout.slice();
		stderr = capture.stderr.slice();
	} finally {
		endCommandCapture(capture);
	}
	const packed = packVectors(names);
	self.postMessage(
		{
			type: 'state-result',
			requestId,
			alters,
			rc,
			ms,
			stdout,
			stderr,
			index: packed.index,
			real: packed.real,
			imag: packed.imag,
			readMs: packed.ms,
		},
		packed.transferables,
	);
}

/**
 * Read the current state of a named vector. For DC operating point this
 * is a single scalar; for `.tran` it's the entire time series of samples
 * captured so far.
 */
function handleReadVec(requestId, vectorName) {
	const infoPtr = api.getVecInfo(vectorName);
	if (!infoPtr) {
		throw new Error(`Vector '${vectorName}' not found. Run an analysis first.`);
	}
	const data = readVectorData(infoPtr, /* readImag */ true);
	const transferables = [data.real.buffer];
	if (data.imag) transferables.push(data.imag.buffer);
	self.postMessage(
		{
			type: 'vec',
			requestId,
			name: vectorName,
			real: data.real,
			imag: data.imag,
			complex: data.complex,
			unit: data.unit,
		},
		transferables,
	);
}

/**
 * Enumerate every vector in the current plot.  Phase 1d #6.
 * `ngSpice_AllVecs` returns a NULL-terminated char** array; we walk
 * it until the first 0 pointer and decode each cstring.  Names are
 * case-preserved — getVecInfo lookups care about case.
 */
function handleListVectors(requestId) {
	const plot = api.curPlot && api.curPlot();
	const names = [];
	if (plot) {
		const arrPtr = api.allVecs(plot);
		if (arrPtr) {
			for (let i = 0; i < 4096; i++) {
				const ptr = HEAPU32[(arrPtr >> 2) + i];
				if (!ptr) break;
				names.push(Module.UTF8ToString(ptr));
			}
		}
	}
	self.postMessage({ type: 'vector-list', requestId, names });
}

// ── Command-capture machinery (Phase 1a) ────────────────────────────
//
// onPrint pushes to currentRun.log.stdout when a batch run is active.
// For interactive commands we need our own capture buffer so the
// caller of `command()` gets the lines that command produced.

let activeCommandCapture = null;

function beginCommandCapture(requestId) {
	activeCommandCapture = {
		requestId,
		stdout: [],
		stderr: [],
	};
	return activeCommandCapture;
}

function endCommandCapture(capture) {
	if (activeCommandCapture === capture) {
		activeCommandCapture = null;
	}
}

// freeCStringArray and allocateCStringArray are defined further down in
// the file as part of the existing batch-mode infrastructure — reused
// here.

async function runSimulation(requestId, netlist) {
	if (!netlist.trim()) {
		throw new Error('Netlist is empty.');
	}

	if (currentRun) {
		throw new Error('A library simulation is already in progress.');
	}

	resetNgspice();
	await ensureSession(moduleConfig || {});

	currentRun = {
		requestId,
		finalTime: extractTranFinalTime(netlist),
		lastProgress: 0,
		lastCurrentTime: 0,
		lastEmitAt: 0,
		timeVectorName: 'time',
	};

	postDebug('run-start', { finalTime: currentRun.finalTime, netlistLines: netlist.split(/\r?\n/).length });

	self.postMessage({ type: 'status', requestId, message: 'Submitting circuit to shared ngspice…' });

	const circuitLines = buildCircuitLines(netlist);
	const allocations = allocateCStringArray(circuitLines);

	try {
		const rc = api.circ(allocations.arrayPointer);
		if (rc !== 0) {
			throw new Error(`ngSpice_Circ failed with status ${rc}.`);
		}

		emitProgress(true);

		const analyses = extractAllAnalyses();
		const transferables = collectTransferables(analyses);

		self.postMessage(
			{
				type: 'done',
				requestId,
				exitCode: rc,
				finalTime: currentRun.finalTime,
				progress: currentRun.lastProgress,
				analyses,
			},
			transferables,
		);
	} finally {
		freeCStringArray(allocations);
		currentRun = null;
	}
}

// ---------------------------------------------------------------------------
// Post-simulation data extraction
// ---------------------------------------------------------------------------

function extractAllAnalyses() {
	const plotNames = readAllPlotNames();
	const analyses = [];

	for (const plotName of plotNames) {
		if (plotName === 'const') {
			continue;
		}

		const analysis = extractPlotAnalysis(plotName);
		if (analysis) {
			analyses.push(analysis);
		}
	}

	postDebug('extract-analyses', { plotCount: plotNames.length, analysisCount: analyses.length });
	return analyses;
}

function readAllPlotNames() {
	const plotsPtr = api.allPlots();
	if (!plotsPtr) {
		return [];
	}

	const names = [];
	let offset = plotsPtr;
	while (true) {
		const strPtr = HEAPU32[offset >> 2];
		if (!strPtr) {
			break;
		}
		names.push(Module.UTF8ToString(strPtr));
		offset += 4;
	}
	return names;
}

function readAllVecNames(plotName) {
	const vecsPtr = api.allVecs(plotName);
	if (!vecsPtr) {
		return [];
	}

	const names = [];
	let offset = vecsPtr;
	while (true) {
		const strPtr = HEAPU32[offset >> 2];
		if (!strPtr) {
			break;
		}
		names.push(Module.UTF8ToString(strPtr));
		offset += 4;
	}
	return names;
}

function extractPlotAnalysis(plotName) {
	const vecNames = readAllVecNames(plotName);
	if (vecNames.length === 0) {
		return null;
	}

	const analysisType = detectAnalysisType(plotName);
	const isComplex = analysisType === 'ac';
	const isScalar = SCALAR_ANALYSIS_TYPES.has(analysisType);

	let sweepVec = null;
	const dataVecs = [];

	for (const vecName of vecNames) {
		const qualifiedName = `${plotName}.${vecName}`;
		const infoPtr = api.getVecInfo(qualifiedName);
		if (!infoPtr) {
			continue;
		}

		const vecData = readVectorData(infoPtr, isComplex);
		if (!vecData) {
			continue;
		}

		const typeFlags = HEAP32[(infoPtr + VECTOR_INFO_TYPE_OFFSET) >> 2];
		// SV_TIME=1, SV_FREQUENCY=2 are scale (independent) vectors
		const svType = typeFlags & 0xFF;
		const isScale = svType === 1 || svType === 2;

		if (isScale) {
			sweepVec = { name: vecName, ...vecData };
		} else {
			dataVecs.push({ name: vecName, ...vecData });
		}
	}

	if (isScalar) {
		return buildScalarResult(analysisType, plotName, sweepVec, dataVecs);
	}

	return buildVectorResult(analysisType, plotName, sweepVec, dataVecs, isComplex);
}

function readVectorData(infoPtr, readImag) {
	const length = HEAP32[(infoPtr + VECTOR_INFO_LENGTH_OFFSET) >> 2];
	if (length <= 0) {
		return null;
	}

	const realDataPtr = HEAPU32[(infoPtr + VECTOR_INFO_REALDATA_OFFSET) >> 2];
	const compDataPtr = HEAPU32[(infoPtr + VECTOR_INFO_IMAGDATA_OFFSET) >> 2];

	// For complex vectors (AC analysis), ngspice stores data as an array of
	// ngcomplex_t structs ({double real; double imag;}) in the compdata field,
	// with realdata set to NULL.
	if (!realDataPtr && compDataPtr && readImag) {
		const real = new Float64Array(length);
		const imag = new Float64Array(length);
		const baseIdx = compDataPtr >> 3; // byte offset to float64 index
		for (let i = 0; i < length; i++) {
			real[i] = HEAPF64[baseIdx + i * 2];
			imag[i] = HEAPF64[baseIdx + i * 2 + 1];
		}
		return { real, imag, length };
	}

	if (!realDataPtr) {
		return null;
	}

	const real = new Float64Array(length);
	real.set(HEAPF64.subarray(realDataPtr >> 3, (realDataPtr >> 3) + length));

	let imag = null;
	if (readImag && compDataPtr) {
		// If both realdata and compdata exist, compdata holds ngcomplex_t structs
		imag = new Float64Array(length);
		const baseIdx = compDataPtr >> 3;
		for (let i = 0; i < length; i++) {
			imag[i] = HEAPF64[baseIdx + i * 2 + 1];
		}
	}

	return { real, imag, length };
}

function buildScalarResult(analysisType, plotName, sweepVec, dataVecs) {
	const scalars = {};

	if (sweepVec) {
		for (let i = 0; i < sweepVec.length; i++) {
			scalars[sweepVec.name] = sweepVec.real[0];
		}
	}

	for (const vec of dataVecs) {
		scalars[vec.name] = vec.real[0];
	}

	return {
		type: analysisType,
		sweep: null,
		vectors: [],
		scalars,
		meta: { plotName },
	};
}

function buildVectorResult(analysisType, plotName, sweepVec, dataVecs, isComplex) {
	const sweep = sweepVec
		? {
				name: sweepVec.name,
				unit: inferUnit(sweepVec.name),
				values: sweepVec.real,
			}
		: null;

	const vectors = dataVecs.map((vec) => ({
		name: vec.name,
		unit: inferUnit(vec.name),
		real: vec.real,
		imag: isComplex ? vec.imag : null,
		complex: isComplex,
	}));

	return {
		type: analysisType,
		sweep,
		vectors,
		scalars: null,
		meta: { plotName },
	};
}

function detectAnalysisType(plotName) {
	const match = plotName.match(/^(tran|ac|dc|op|noise|sens|tf|pz)/i);
	if (match) {
		return match[1].toLowerCase();
	}
	return 'unknown';
}

function inferUnit(vectorName) {
	const lower = vectorName.toLowerCase();
	if (lower === 'time') return 's';
	if (lower === 'frequency') return 'Hz';
	if (/^v\(/.test(lower) || /^v_/.test(lower)) return 'V';
	if (/^i\(/.test(lower) || /^i_/.test(lower)) return 'A';
	if (/^p\(/.test(lower)) return 'W';
	return '';
}

function collectTransferables(analyses) {
	const buffers = new Set();

	for (const analysis of analyses) {
		if (analysis.sweep) {
			buffers.add(analysis.sweep.values.buffer);
		}

		for (const vec of analysis.vectors) {
			buffers.add(vec.real.buffer);
			if (vec.imag) {
				buffers.add(vec.imag.buffer);
			}
		}
	}

	return [...buffers];
}

// ---------------------------------------------------------------------------
// Netlist preprocessing
// ---------------------------------------------------------------------------

function buildCircuitLines(netlist) {
	const lines = netlist.replace(/\r/g, '').split('\n');
	const filtered = [];
	let inControl = false;

	for (const line of lines) {
		const trimmed = line.trim().toLowerCase();

		if (/^\.control\b/.test(trimmed)) {
			inControl = true;
			filtered.push(line);
			continue;
		}

		if (/^\.endc\b/.test(trimmed)) {
			inControl = false;
			filtered.push(line);
			continue;
		}

		if (inControl) {
			if (/^save\b/.test(trimmed) || /^wrdt\b/.test(trimmed)) {
				continue;
			}
			filtered.push(line);
			continue;
		}

		if (/^\s*\.save\b/i.test(line) || /^\s*\.wrdt\b/i.test(line)) {
			continue;
		}

		filtered.push(line);
	}

	const hasEnd = filtered.some((line) => /^\s*\.end\s*$/i.test(line));
	if (!hasEnd) {
		filtered.push('.end');
	}
	return filtered;
}

// ---------------------------------------------------------------------------
// Session & module setup
// ---------------------------------------------------------------------------

async function ensureSession(config) {
	await ensureModule(config);

	if (!filesystemReady) {
		self.postMessage({ type: 'status', requestId: config.requestId, message: 'Staging library assets…' });
		await stageFilesystem();
		filesystemReady = true;
	}

	if (!callbackPointers) {
		registerCallbacks();
	}

	if (!ngspiceInitialized) {
		initializeNgspice();
	}
}

async function ensureModule(config) {
	if (!moduleReady) {
		moduleConfig = normalizeConfig(config);
		moduleReady = new Promise((resolve, reject) => {
			self.Module = {
				noInitialRun: true,
				locateFile: (path) => {
					if (path.endsWith('.wasm')) {
						return resolveAssetUrl(moduleConfig.assetBaseUrl, moduleConfig.wasmFile);
					}
					return path;
				},
				print: (text) => {
					if (currentRun) {
						self.postMessage({ type: 'stdout', requestId: currentRun.requestId, line: text });
					}
				},
				printErr: (text) => {
					if (currentRun && !text.includes('keepRuntimeAlive() is set')) {
						self.postMessage({ type: 'stderr', requestId: currentRun.requestId, line: text });
					}
				},
				onRuntimeInitialized: () => {
					bindApi();
					resolve();
				},
			};

			try {
				importScripts(resolveAssetUrl(moduleConfig.assetBaseUrl, moduleConfig.moduleScript));
			} catch (error) {
				reject(error);
			}
		});
	}

	return moduleReady;
}

function bindApi() {
	api = {
		init: Module.cwrap('ngSpice_Init', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
		command: Module.cwrap('ngSpice_Command', 'number', ['string']),
		circ: Module.cwrap('ngSpice_Circ', 'number', ['number']),
		curPlot: Module.cwrap('ngSpice_CurPlot', 'string', []),
		allPlots: Module.cwrap('ngSpice_AllPlots', 'number', []),
		allVecs: Module.cwrap('ngSpice_AllVecs', 'number', ['string']),
		getVecInfo: Module.cwrap('ngGet_Vec_Info', 'number', ['string']),
		reset: Module.cwrap('ngSpice_Reset', 'number', []),
		nospiceinit: Module.cwrap('ngSpice_nospiceinit', 'number', []),
		setInputPath: Module.cwrap('ngCM_Input_Path', 'number', ['string']),
	};
}

function registerCallbacks() {
	callbackPointers = {
		print: Module.addFunction(onPrint, 'iiii'),
		status: Module.addFunction(onStatus, 'iiii'),
		exit: Module.addFunction(onControlledExit, 'iiiiii'),
		data: Module.addFunction(onData, 'iiiii'),
		dataInit: Module.addFunction(onDataInit, 'iiii'),
		bg: Module.addFunction(onBackground, 'iiii'),
	};
}

function initializeNgspice() {
	api.nospiceinit();
	const rc = api.init(
		callbackPointers.print,
		callbackPointers.status,
		callbackPointers.exit,
		callbackPointers.data,
		callbackPointers.dataInit,
		callbackPointers.bg,
		0,
	);

	if (rc !== 0) {
		throw new Error(`ngSpice_Init failed with status ${rc}.`);
	}

	api.setInputPath('/');
	api.command('set xspice_enabled');
	api.command('source /spinit');
	ngspiceInitialized = true;
}

function resetNgspice() {
	if (!ngspiceInitialized || !api) {
		return;
	}

	api.reset();
	ngspiceInitialized = false;
}

async function stageFilesystem() {
	ensurePath('/usr/local/lib/ngspice');
	ensurePath('/usr/local/share/ngspice/scripts');

	for (const [index, name] of MODEL_FILES.entries()) {
		self.postMessage({
			type: 'status',
			message: `Loading code model ${index + 1}/${MODEL_FILES.length}: ${name}`,
		});
		const data = await fetchBinary(name);
		FS.writeFile(`/usr/local/lib/ngspice/${name}`, new Uint8Array(data));
	}

	const spinitText = await fetchText('spinit');
	FS.writeFile('/usr/local/share/ngspice/scripts/spinit', spinitText);
	FS.writeFile('/spinit', spinitText);
}

// ---------------------------------------------------------------------------
// Ngspice callbacks (invoked during simulation)
// ---------------------------------------------------------------------------

function onPrint(messagePtr) {
	const text = Module.UTF8ToString(messagePtr);
	const isStderr = text.startsWith('stderr ');
	const isStdout = text.startsWith('stdout ');
	const body = isStderr ? text.slice(7) : isStdout ? text.slice(7) : text;
	const channel = isStderr ? 'stderr' : 'stdout';

	// Interactive command capture: route stdout/stderr from a command()
	// call into the per-command buffer AND emit a live event.
	if (activeCommandCapture) {
		if (isStderr) {
			activeCommandCapture.stderr.push(body);
		} else {
			activeCommandCapture.stdout.push(body);
		}
		self.postMessage({ type: channel, requestId: activeCommandCapture.requestId, line: body });
		return 0;
	}

	// Batch run path — unchanged from the original worker.
	if (currentRun) {
		self.postMessage({ type: channel, requestId: currentRun.requestId, line: body });
	}
	return 0;
}

function onStatus(messagePtr) {
	if (currentRun) {
		const message = Module.UTF8ToString(messagePtr);
		self.postMessage({ type: 'status', requestId: currentRun.requestId, message });
	}
	return 0;
}

function onControlledExit(status, immediate, fromQuit) {
	if (currentRun && status !== 0 && !fromQuit) {
		self.postMessage({
			type: 'stderr',
			requestId: currentRun.requestId,
			line: `shared ngspice requested exit ${status} (immediate=${Boolean(immediate)})`,
		});
	}
	return 0;
}

function onData(vecvaluesAllPtr, vectorCount) {
	const currentTime = readCurrentTimeFromData(vecvaluesAllPtr, vectorCount);
	postDebug('data-callback', {
		vecvaluesAllPtr,
		vectorCount,
		currentTime,
		timeVectorName: currentRun?.timeVectorName,
	});
	emitProgress(false, currentTime);
	return 0;
}

function onDataInit(vecinfoAllPtr) {
	if (currentRun) {
		const timeVectorName = findTimeVectorName(vecinfoAllPtr);
		if (timeVectorName) {
			currentRun.timeVectorName = timeVectorName;
		}
		postDebug('data-init-callback', {
			vecinfoAllPtr,
			timeVectorName: currentRun.timeVectorName,
		});
	}

	if (currentRun) {
		self.postMessage({ type: 'status', requestId: currentRun.requestId, message: 'Transient vectors initialized.' });
	}
	return 0;
}

function onBackground() {
	return 0;
}

// ---------------------------------------------------------------------------
// Progress tracking helpers
// ---------------------------------------------------------------------------

function emitProgress(force, currentTimeOverride = null) {
	if (!currentRun || !currentRun.finalTime || currentRun.finalTime <= 0) {
		return;
	}

	const currentTime = currentTimeOverride ?? readLatestVectorValue(currentRun.timeVectorName || 'time');
	if (currentTime === null) {
		return;
	}

	const now = Date.now();
	const progress = Math.min(Math.max(currentTime / currentRun.finalTime, currentRun.lastProgress), 1);
	if (!force && progress - currentRun.lastProgress < 0.001 && now - currentRun.lastEmitAt < 80) {
		return;
	}

	currentRun.lastProgress = progress;
	currentRun.lastCurrentTime = currentTime;
	currentRun.lastEmitAt = now;
	self.postMessage({
		type: 'progress',
		requestId: currentRun.requestId,
		currentTime,
		finalTime: currentRun.finalTime,
		progress,
	});
}

function readLatestVectorValue(vectorName) {
	let vectorInfoPtr = api.getVecInfo(vectorName);
	if (!vectorInfoPtr && !vectorName.includes('.')) {
		const currentPlot = api.curPlot?.();
		if (currentPlot) {
			vectorInfoPtr = api.getVecInfo(`${currentPlot}.${vectorName}`);
		}
	}

	if (!vectorInfoPtr) {
		return null;
	}

	const realDataPtr = HEAPU32[(vectorInfoPtr + VECTOR_INFO_REALDATA_OFFSET) >> 2];
	const length = HEAP32[(vectorInfoPtr + VECTOR_INFO_LENGTH_OFFSET) >> 2];
	if (!realDataPtr || length <= 0) {
		return null;
	}

	return HEAPF64[(realDataPtr >> 3) + length - 1];
}

function readCurrentTimeFromData(vecvaluesAllPtr, vectorCount) {
	if (!vecvaluesAllPtr) {
		return null;
	}

	const count = vectorCount || HEAP32[(vecvaluesAllPtr + VECVALUESALL_COUNT_OFFSET) >> 2];
	const valuesPtr = HEAPU32[(vecvaluesAllPtr + VECVALUESALL_VALUES_OFFSET) >> 2];
	if (!valuesPtr || count <= 0) {
		return null;
	}

	for (let index = 0; index < count; index += 1) {
		const vecvaluePtr = HEAPU32[(valuesPtr >> 2) + index];
		if (!vecvaluePtr) {
			continue;
		}

		const namePtr = HEAPU32[(vecvaluePtr + VECVALUES_NAME_OFFSET) >> 2];
		const name = namePtr ? Module.UTF8ToString(namePtr) : '';
		const isScale = HEAPU8[vecvaluePtr + VECVALUES_IS_SCALE_OFFSET] !== 0;
		if (!isScale && name !== 'time' && name !== currentRun?.timeVectorName) {
			continue;
		}

		return HEAPF64[(vecvaluePtr + VECVALUES_REAL_OFFSET) >> 3];
	}

	return null;
}

function findTimeVectorName(vecinfoAllPtr) {
	if (!vecinfoAllPtr) {
		return null;
	}

	const count = HEAP32[(vecinfoAllPtr + VECINFOALL_COUNT_OFFSET) >> 2];
	const vecsPtr = HEAPU32[(vecinfoAllPtr + VECINFOALL_VECS_OFFSET) >> 2];
	if (!vecsPtr || count <= 0) {
		return null;
	}

	for (let index = 0; index < count; index += 1) {
		const vecinfoPtr = HEAPU32[(vecsPtr >> 2) + index];
		if (!vecinfoPtr) {
			continue;
		}

		const namePtr = HEAPU32[(vecinfoPtr + VECINFO_NAME_OFFSET) >> 2];
		if (!namePtr) {
			continue;
		}

		const name = Module.UTF8ToString(namePtr);
		if (name === 'time') {
			return name;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Netlist parsing helpers
// ---------------------------------------------------------------------------

function extractTranFinalTime(netlist) {
	for (const line of netlist.split(/\r?\n/)) {
		if (!/^\s*\.?tran\b/i.test(line)) {
			continue;
		}

		const tokens = line.trim().split(/\s+/);
		if (tokens.length < 3) {
			postDebug('tran-parse-skipped', { line, reason: 'too-few-tokens' });
			return null;
		}

		const finalTime = parseScaledNumber(tokens[2]);
		postDebug('tran-parse-result', { line, tokens, finalTime });
		return finalTime;
	}

	postDebug('tran-parse-missed', { reason: 'no-tran-line-found' });
	return null;
}

function parseScaledNumber(token) {
	const match = token.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-zA-Z]+)?$/);
	if (!match) {
		return null;
	}

	const value = Number(match[1]);
	const suffix = (match[2] || '').toLowerCase();
	const multipliers = {
		t: 1e12,
		g: 1e9,
		meg: 1e6,
		k: 1e3,
		m: 1e-3,
		u: 1e-6,
		n: 1e-9,
		p: 1e-12,
		f: 1e-15,
	};

	if (!suffix) {
		return value;
	}

	return value * (multipliers[suffix] || 1);
}

// ---------------------------------------------------------------------------
// Utility: memory allocation, URLs, filesystem
// ---------------------------------------------------------------------------

function allocateCStringArray(lines) {
	const pointerSize = 4;
	const stringPointers = lines.map((line) => allocateCString(line));
	const arrayPointer = _malloc((stringPointers.length + 1) * pointerSize);

	stringPointers.forEach((pointer, index) => {
		HEAPU32[(arrayPointer >> 2) + index] = pointer;
	});
	HEAPU32[(arrayPointer >> 2) + stringPointers.length] = 0;

	return { arrayPointer, stringPointers };
}

function freeCStringArray({ arrayPointer, stringPointers }) {
	stringPointers.forEach((pointer) => _free(pointer));
	_free(arrayPointer);
}

function allocateCString(value) {
	const length = Module.lengthBytesUTF8(value) + 1;
	const pointer = _malloc(length);
	Module.stringToUTF8(value, pointer, length);
	return pointer;
}

function normalizeConfig(config) {
	return {
		assetBaseUrl: config.assetBaseUrl || './',
		moduleScript: config.moduleScript || 'ngspice-lib.js',
		wasmFile: config.wasmFile || 'ngspice-lib.wasm',
	};
}

function resolveAssetUrl(basePath, fileName) {
	return new URL(`${trimTrailingSlash(basePath)}/${fileName}`, self.location.href).toString();
}

function trimTrailingSlash(value) {
	return value.replace(/\/$/, '');
}

async function fetchBinary(fileName) {
	const response = await fetch(resolveAssetUrl(moduleConfig.assetBaseUrl, fileName));
	if (!response.ok) {
		throw new Error(`Failed to fetch ${fileName}: ${response.status} ${response.statusText}`);
	}
	return response.arrayBuffer();
}

async function fetchText(fileName) {
	const response = await fetch(resolveAssetUrl(moduleConfig.assetBaseUrl, fileName));
	if (!response.ok) {
		throw new Error(`Failed to fetch ${fileName}: ${response.status} ${response.statusText}`);
	}
	return response.text();
}

function ensurePath(path) {
	const parts = path.split('/').filter(Boolean);
	let current = '/';
	for (const part of parts) {
		FS.createPath(current, part, true, true);
		current = current === '/' ? `/${part}` : `${current}/${part}`;
	}
}
