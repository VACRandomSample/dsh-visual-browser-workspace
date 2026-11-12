// VBW host plugin — registers the vbw_* tools.
//
// Contract: @deepseek-ai/dsh-tools README L38-L64 (audit §10):
//   ctx.tools.register(defineTool({ name, description, parameters, output,
//   execute })) — registering is enough; the registry feeds the schemas into
//   system-prompt assembly automatically. Every execute() honors exec.signal
//   (cooperative cancellation, dsh-tools "Execution and cancellation").
//
// The tools are thin HTTP proxies to the VBW broker (_vbw\specs\broker-api.md).
// Plugin config (cordis.patch.yml vbw-tools group → vbw-host row):
//   brokerRoot   path to the broker checkout (default '..\broker', relative to
//                the bundle root; absolute paths pass through)
//   autoSpawn    spawn `node src/server.mjs` when the state file is
//                missing/stale and /health is down (default true)
//   stateFile    override for the broker discovery state file
//                  (default %LOCALAPPDATA%\vbw\state\broker.json, SEC-2)
//   nodePath     override for the node executable used to spawn the broker
//   tools        array of tool names to register (default: ALL — SEC-11 lets each
//                preset row mount only its subset, e.g. without vbw_test_run)
//   requestTimeoutMs / spawnWaitMs / testPollIntervalMs / testMaxWaitMs

import { defineTool } from './define-tool.js';
import {
	BrokerError,
	abortError,
	brokerRequest,
	ensureBroker,
	resolveConfig,
	resolveSessionId
} from './broker-client.js';

const OBJECT_OUTPUT = { schema: { type: 'object' } };

/** Render tool output as pretty JSON text (registry-visible content). */
function renderJson(_args, value) {
	return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function withNote(value, note) {
	return { ...value, note };
}

/** SessionId parameter shared by the session-scoped tools. */
const sessionIdParam = {
	type: 'string',
	description: 'Broker session id. Omit to target the most recently used agent-owned session.'
};

/**
 * SEC-11: all tools are built up-front; `apply` registers only the configured
 * subset. `config.tools` (array of tool names, default = ALL for backwards
 * compatibility) lets each cordis preset row mount exactly its drive set —
 * e.g. the read-only presets omit vbw_test_run while the tester keeps it.
 */
function buildTools(cfg) {
	const TOOLS = {};

	TOOLS.vbw_status = defineTool({
		name: 'vbw_status',
		description: 'VBW broker health and session overview: GET /health plus the current session list (owners, locks, urls, idle times).',
		parameters: {},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(_args, exec) {
			// SEC-11: the port comes from the resolved config/state file (ensureBroker),
			// NOT from the /health body — GET /health deliberately exposes no port.
			const { baseUrl } = await ensureBroker(cfg, exec.signal);
			const health = await brokerRequest(cfg, '/health', { signal: exec.signal });
			const sessions = await brokerRequest(cfg, '/sessions', { signal: exec.signal }).catch(() => null);
			const list = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
			return withNote({
				broker: health,
				baseUrl,
				sessions: list.map((session) => ({
					id: session.id,
					owner: session.owner,
					label: session.label ?? undefined,
					url: session.url ?? undefined,
					title: session.title ?? undefined,
					status: session.status,
					lock: session.lock ?? null,
					lastOpAt: session.lastOpAt ?? undefined
				}))
			}, health?.ok === true ? 'broker is healthy' : 'broker answered /health without ok:true');
		}
	});

	TOOLS.vbw_session_open = defineTool({
		name: 'vbw_session_open',
		description: 'Open a new broker browser session (Playwright context + page) owned by "agent" with optional start URL, viewport, and label.',
		parameters: {
			url: { type: 'string', description: 'Initial http(s) URL to navigate to (optional).' },
			viewport: {
				type: 'object',
				description: 'Viewport override { width, height } in CSS pixels.',
				properties: {
					width: { type: 'number', required: true, description: 'Viewport width.' },
					height: { type: 'number', required: true, description: 'Viewport height.' }
				}
			},
			label: { type: 'string', description: 'Free-form label for the session list.' }
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const body = { owner: 'agent' };
			if (args.url !== undefined) body.url = args.url;
			if (args.viewport !== undefined) body.viewport = args.viewport;
			if (args.label !== undefined) body.label = args.label;
			const created = await brokerRequest(cfg, '/sessions', { method: 'POST', body, signal: exec.signal, timeoutMs: 60000 });
			return withNote(created, 'session opened with owner "agent"; pass its id as sessionId in later vbw_* calls');
		}
	});

	TOOLS.vbw_navigate = defineTool({
		name: 'vbw_navigate',
		description: 'Navigate the broker session page to an http(s) URL and wait for the chosen lifecycle event; returns the resulting url + title.',
		parameters: {
			sessionId: sessionIdParam,
			url: { type: 'string', required: true, description: 'Target http(s) URL (file:/data:/credential URLs are refused by the broker).' },
			waitUntil: { type: 'string', description: 'Playwright wait: "load" (default), "domcontentloaded", or "networkidle".' },
			timeoutMs: { type: 'number', description: 'Navigation timeout in milliseconds.' }
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const sessionId = await resolveSessionId(cfg, args.sessionId, exec.signal);
			const body = { url: args.url };
			if (args.waitUntil !== undefined) body.waitUntil = args.waitUntil;
			if (args.timeoutMs !== undefined) body.timeoutMs = args.timeoutMs;
			const result = await brokerRequest(cfg, `/sessions/${encodeURIComponent(sessionId)}/navigate`, { method: 'POST', body, signal: exec.signal, timeoutMs: Math.max(args.timeoutMs ?? 0, cfg.requestTimeoutMs) + 5000 });
			return withNote(result, `navigated session ${sessionId}`);
		}
	});

	TOOLS.vbw_screenshot = defineTool({
		name: 'vbw_screenshot',
		description: 'Screenshot the broker session page (viewport, full page, or a clipped region). Returns the persisted file path; the base64 dataUrl is omitted from chat output unless returnDataUrl is true.',
		parameters: {
			sessionId: sessionIdParam,
			clip: {
				type: 'object',
				description: 'Region to capture, viewport-relative CSS pixels { x, y, width, height } (Playwright clip semantics at fullPage:false).',
				properties: {
					x: { type: 'number', required: true, description: 'Left edge.' },
					y: { type: 'number', required: true, description: 'Top edge.' },
					width: { type: 'number', required: true, description: 'Width.' },
					height: { type: 'number', required: true, description: 'Height.' }
				}
			},
			fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
			format: { type: 'string', description: 'Image format: "jpeg" (default) or "png".' },
			quality: { type: 'number', description: 'JPEG quality 0-100.' },
			save: { type: 'boolean', description: 'Persist the image under the VBW state screenshots dir (returns "file"). Default true.' },
			returnDataUrl: { type: 'boolean', description: 'Include the full dataUrl in the result (large; avoid in chat contexts).' }
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const sessionId = await resolveSessionId(cfg, args.sessionId, exec.signal);
			const body = {};
			if (args.clip !== undefined) body.clip = args.clip;
			if (args.fullPage !== undefined) body.fullPage = args.fullPage;
			if (args.format !== undefined) body.format = args.format;
			if (args.quality !== undefined) body.quality = args.quality;
			body.save = args.save !== false;
			const result = await brokerRequest(cfg, `/sessions/${encodeURIComponent(sessionId)}/screenshot`, { method: 'POST', body, signal: exec.signal, timeoutMs: 60000 });
			const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl : undefined;
			const output = {
				sessionId,
				file: result?.file,
				dataUrlBytes: dataUrl === undefined ? 0 : dataUrl.length,
				dataUrl: args.returnDataUrl === true ? dataUrl : undefined
			};
			return withNote(output, dataUrl === undefined
				? 'screenshot captured; dataUrl withheld from chat (pass returnDataUrl:true to include it)'
				: `screenshot captured${output.file ? `; saved to ${output.file}` : ''}`);
		}
	});

	TOOLS.vbw_read_text = defineTool({
		name: 'vbw_read_text',
		description: 'Read the visible text of the broker session page, paged by character offset; broker-side secret-pattern redaction applies.',
		parameters: {
			sessionId: sessionIdParam,
			start: { type: 'number', description: 'Character offset to start from (default 0).' },
			count: { type: 'number', description: 'Number of characters to return (default 4000).' }
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const sessionId = await resolveSessionId(cfg, args.sessionId, exec.signal);
			const body = {};
			if (args.start !== undefined) body.start = args.start;
			if (args.count !== undefined) body.count = args.count;
			const result = await brokerRequest(cfg, `/sessions/${encodeURIComponent(sessionId)}/read-text`, { method: 'POST', body, signal: exec.signal });
			return withNote(result, `text ${result?.start ?? '?'}–${result?.end ?? '?'} of ${result?.totalChars ?? '?'} chars${result?.url ? ` on ${result.url}` : ''}`);
		}
	});

	TOOLS.vbw_inventory = defineTool({
		name: 'vbw_inventory',
		description: 'Interactive-element inventory of the broker session page (refs, roles, labels, boxes, optional source refs) with a Hermes-style delta since the last call. Safe metadata only — input values are never returned.',
		parameters: {
			sessionId: sessionIdParam,
			max: { type: 'number', description: 'Maximum elements (broker cap 120).' }
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const sessionId = await resolveSessionId(cfg, args.sessionId, exec.signal);
			const body = {};
			if (args.max !== undefined) body.max = args.max;
			const result = await brokerRequest(cfg, `/sessions/${encodeURIComponent(sessionId)}/inventory`, { method: 'POST', body, signal: exec.signal });
			const delta = result?.delta;
			return withNote(result, `inventory of ${sessionId}: ${result?.elements?.length ?? 0} elements (added ${delta?.added?.length ?? 0}, changed ${delta?.changed?.length ?? 0}, removed ${delta?.removed?.length ?? 0}, rebound ${delta?.rebound?.length ?? 0})`);
		}
	});

	TOOLS.vbw_element_at = defineTool({
		name: 'vbw_element_at',
		description: 'Safe metadata for the element at viewport coordinates (x, y) in the broker session page, plus its source mapping and confidence when available.',
		parameters: {
			sessionId: sessionIdParam,
			x: { type: 'number', required: true, description: 'Viewport-relative X in CSS pixels.' },
			y: { type: 'number', required: true, description: 'Viewport-relative Y in CSS pixels.' }
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const sessionId = await resolveSessionId(cfg, args.sessionId, exec.signal);
			const result = await brokerRequest(cfg, `/sessions/${encodeURIComponent(sessionId)}/element-at`, {
				method: 'POST',
				body: { x: args.x, y: args.y },
				signal: exec.signal
			});
			return withNote(result, result?.found ? `element at (${args.x}, ${args.y})` : `no element at (${args.x}, ${args.y})`);
		}
	});

	TOOLS.vbw_map_source = defineTool({
		name: 'vbw_map_source',
		description: 'Map a page element (by ref, CSS selector, or viewport coordinates) to its source location: React fiber _debugSource, sourcemap, or heuristic fallback with confidence and evidence.',
		parameters: {
			sessionId: sessionIdParam,
			ref: { type: 'string', description: 'Inventory element ref (e.g. btn-sign-in).' },
			selector: { type: 'string', description: 'CSS selector.' },
			x: { type: 'number', description: 'Viewport-relative X (used when ref/selector omitted).' },
			y: { type: 'number', description: 'Viewport-relative Y (used when ref/selector omitted).' }
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const sessionId = await resolveSessionId(cfg, args.sessionId, exec.signal);
			const body = {};
			if (args.ref !== undefined) body.ref = args.ref;
			if (args.selector !== undefined) body.selector = args.selector;
			if (args.x !== undefined) body.x = args.x;
			if (args.y !== undefined) body.y = args.y;
			const result = await brokerRequest(cfg, `/sessions/${encodeURIComponent(sessionId)}/map-source`, { method: 'POST', body, signal: exec.signal });
			const match = result?.match;
			return withNote(result, match
				? `source: ${match.fileName}${match.lineNumber !== undefined && match.lineNumber !== null ? `:${match.lineNumber}` : ''} via ${match.origin} (confidence ${match.confidence})`
				: 'no source mapping found');
		}
	});

	TOOLS.vbw_fetch_annotations = defineTool({
		name: 'vbw_fetch_annotations',
		description: 'Fetch annotation groups the user delivered from the Visual Browser UI (numbered comments with safe metadata, source refs, screenshot file paths — the broker strips inline screenshot dataUrls unless includeShots=1); optionally acknowledge them to clear the pending queue.',
		parameters: {
			ack: { type: 'boolean', description: 'Acknowledge the fetched groups after delivery (default false).' },
			groupIds: {
				type: 'array',
				description: 'Explicit group ids to acknowledge (used with ack:true; default: the groups just fetched).',
				items: { type: 'string' }
			}
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const pending = await brokerRequest(cfg, '/annotations/pending', { signal: exec.signal });
			const groups = Array.isArray(pending?.groups) ? pending.groups : [];
			let acked;
			if (args.ack === true) {
				const ids = args.groupIds ?? groups.map((group) => group.groupId ?? group.id).filter(Boolean);
				if (ids.length > 0) {
					acked = await brokerRequest(cfg, '/annotations/ack', { method: 'POST', body: { groupIds: ids }, signal: exec.signal });
				}
			}
			return withNote({ groups, acked }, groups.length === 0
				? 'no pending annotation groups'
				: `${groups.length} pending group(s) delivered${acked ? `; acknowledged ${acked.acked ?? args.groupIds?.length ?? groups.length}` : ''}`);
		}
	});

	TOOLS.vbw_test_run = defineTool({
		name: 'vbw_test_run',
		description: 'Run a Playwright test suite in a project directory via the broker (spawns the runner; the broker auto-bootstraps/reuses its managed dev server for the same project, default port 5173, and leaves it running), polls until completion (max 10 minutes) and returns the summary, report dir, and log tail. Cancellation via exec.signal cancels the broker op.',
		parameters: {
			projectDir: { type: 'string', required: true, description: 'Absolute path of the project whose Playwright suite should run.' },
			filter: { type: 'string', description: 'Optional Playwright test filter (file/title regex).' },
			extraArgs: {
				type: 'array',
				description: 'Extra CLI args forwarded to `playwright test` (-c/--config are rejected by the broker).',
				items: { type: 'string' }
			},
			devServerPort: { type: 'number', description: 'Dev-server port the broker should probe/bootstrap before the run (default 5173).' }
		},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(args, exec) {
			const started = await brokerRequest(cfg, '/tests/run', {
				method: 'POST',
				body: {
					projectDir: args.projectDir,
					// CORE-2b: auto-bootstrap the broker-managed dev server for this run
					// (overridable via the devServerPort arg; default 5173).
					devServer: { port: args.devServerPort ?? 5173 },
					...(args.filter !== undefined ? { filter: args.filter } : {}),
					...(args.extraArgs !== undefined ? { extraArgs: args.extraArgs } : {})
				},
				signal: exec.signal,
				timeoutMs: Math.max(cfg.requestTimeoutMs, 90000)
			});
			const runId = started?.runId;
			if (!runId) throw new BrokerError('POST /tests/run did not return a runId');
			const deadline = Date.now() + cfg.testMaxWaitMs;
			let run = null;
			while (Date.now() < deadline) {
				if (exec.signal?.aborted) {
					await brokerRequest(cfg, `/ops/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {}, timeoutMs: 5000 }).catch(() => {});
					throw exec.signal.reason ?? abortError();
				}
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, cfg.testPollIntervalMs);
					exec.signal?.addEventListener('abort', () => {
						clearTimeout(timer);
						reject(exec.signal.reason ?? abortError());
					}, { once: true });
				});
				run = await brokerRequest(cfg, `/tests/runs/${encodeURIComponent(runId)}`, { signal: exec.signal });
				if (run?.status && run.status !== 'running') break;
			}
			if (!run || run.status === 'running') {
				return withNote({ runId, status: 'running', summary: run?.summary }, `test run ${runId} still running after ${Math.round(cfg.testMaxWaitMs / 1000)}s — poll GET /tests/runs/${runId} again or cancel via the broker`);
			}
			return withNote(run, `test run ${runId} ${run.status}: ${run.summary ? `${run.summary.passed ?? 0} passed, ${run.summary.failed ?? 0} failed, ${run.summary.flaky ?? 0} flaky, ${run.summary.skipped ?? 0} skipped` : 'no summary'}${run.reportDir ? `; report: ${run.reportDir}` : ''}`);
		}
	});

	TOOLS.vbw_ui_url = defineTool({
		name: 'vbw_ui_url',
		description: 'The human-facing Visual Browser UI URL served by the broker (open it in the VBW Browser sidebar tab or a normal browser tab; print or present it for the user).',
		parameters: {},
		output: { ...OBJECT_OUTPUT },
		render: renderJson,
		async execute(_args, exec) {
			const { baseUrl } = await ensureBroker(cfg, exec.signal);
			return withNote({
				uiUrl: `${baseUrl}/ui`,
				baseUrl
			}, `open ${baseUrl}/ui for the human Visual Browser UI (print or present this URL)`);
		}
	});

	return TOOLS;
}

const ALL_TOOL_NAMES = [
	'vbw_status',
	'vbw_session_open',
	'vbw_navigate',
	'vbw_screenshot',
	'vbw_read_text',
	'vbw_inventory',
	'vbw_element_at',
	'vbw_map_source',
	'vbw_fetch_annotations',
	'vbw_test_run',
	'vbw_ui_url'
];

export function apply(ctx, config) {
	const cfg = resolveConfig(config, import.meta.url);
	// SEC-11: `config.tools` names the subset to register (default: ALL, backwards
	// compatible). Unknown names are ignored so older bundle rows keep working.
	const requested = Array.isArray(config?.tools) && config.tools.length > 0
		? config.tools.map((name) => String(name)).filter((name) => ALL_TOOL_NAMES.includes(name))
		: null;
	const tools = buildTools(cfg);
	const registered = [];
	for (const name of ALL_TOOL_NAMES) {
		if (requested && !requested.includes(name)) continue;
		ctx.tools.register(tools[name]);
		registered.push(name);
	}
	return {
		brokerRoot: cfg.brokerRoot,
		stateFile: cfg.stateFile,
		autoSpawn: cfg.autoSpawn,
		tools: registered
	};
}
