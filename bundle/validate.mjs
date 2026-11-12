// VBW bundle self-check (@local/vbw-bundle).
//
// Usage: node validate.mjs   (exit 0 = all PASS, exit 1 = at least one FAIL)
//
// Checks (see VALIDATE.md for a real run):
//   1. cordis.patch.yml parses and has patch shape (rows / insert: lists).
//   2. Patch is additive only: top-level rows use only @local/vbw-* names and
//      never reuse ids of shipped rows (audit §8/§9/§11); preset child rows
//      reference only shipped packages from the audit whitelist or this
//      bundle's own packages (documented injection).
//   3. Required rows exist: vbw-client-ui + the 5 preset-vbw-* rows with the
//      right preset ids, order, persona / agent-instructions(65536) /
//      time-context.
//   4. Per-preset tool policy matches the composition map in AGENTS.md
//      (fs read-only vs full, win32 pwsh gating, jobs, web fetch, vbw-tools
//      group rows carrying the vbw-host plugin with brokerRoot + autoSpawn).
//   5. All package.json files parse and carry the required manifest fields.
//   6. Every lib/*.js passes `node --check`.
//   7. lib/client.js is wrapped EXACTLY like the shipped client plugins:
//      `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`.
//   8. The host plugin registers tools via ctx.tools.register(defineTool(...))
//      and every execute() honors exec.signal.
//   9. AGENTS.md documents all five vbw-* roles.

import { parse } from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BUNDLE_ROOT = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, ok, detail = '') {
	const mark = ok ? 'PASS' : 'FAIL';
	if (!ok) failures += 1;
	console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

function readText(relative) {
	return fs.readFileSync(path.join(BUNDLE_ROOT, relative), 'utf8');
}

// ── 1. Patch parses ──────────────────────────────────────────────────────────
// `!!js` is a DSH-allowed tag (ho bundle uses it for platform gating) that the
// plain `yaml` core schema does not resolve; strip the tag for validation and
// keep the raw expression as the value.
const patchRaw = readText('cordis.patch.yml');
const patchText = patchRaw.replace(/!!js /g, '');
let patch;
try {
	patch = parse(patchText);
	check('patch parses as YAML and is a list', Array.isArray(patch));
} catch (error) {
	check('patch parses as YAML and is a list', false, String(error));
	patch = [];
}

const topLevelRows = [];
const insertedRows = [];
for (const entry of Array.isArray(patch) ? patch : []) {
	if (entry && typeof entry === 'object' && Array.isArray(entry.insert)) insertedRows.push(...entry.insert);
	else topLevelRows.push(entry);
}

// ── 2. Additive only ─────────────────────────────────────────────────────────
const SHIPPED_ROW_IDS = new Set([
	// dsh-base / dsh-web-app root rows and shipped preset rows (audit §8/§9/§11)
	'subagent', 'subagent-model-selection-settings', 'webserver', 'web-runtime',
	'ui-sidebar-browser', 'ui-plugin-manager', 'cordis-inspect-providers',
	'ui-settings-account', 'ui-chat', 'ui-settings', 'agent-default-model', 'llm-pi-ai',
	'preset-standard', 'preset-cordis', 'preset-ptc', 'preset-minimal',
	'experimental-inspector',
	// hierarchical-orchestrator-bundle rows (never override another bundle)
	'preset-ho-orchestrator', 'preset-ho-tech-lead', 'preset-ho-quality-lead',
	'preset-ho-explorer', 'preset-ho-backend-developer', 'preset-ho-frontend-developer',
	'preset-ho-test-engineer', 'preset-ho-code-reviewer', 'preset-ho-security-auditor'
]);

const SHIPPED_PACKAGE_NAMES = new Set([
	'@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-persona',
	'@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-time-context',
	'@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search',
	'@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-bash',
	'@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-schedule',
	'@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill',
	'@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-goal',
	'@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control',
	'@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-todo',
	'@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-present',
	'@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact',
	'@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-subagent',
	'@deepseek-ai/dsh-tool-subagent/model-selection-settings'
]);

const topIds = topLevelRows.map((row) => row?.id).filter(Boolean);
check('top-level rows do not reuse shipped row ids', topIds.every((id) => !SHIPPED_ROW_IDS.has(id)), `top-level: ${topIds.join(', ') || '(none)'}`);
// HARDEN-6: the client-ui row moved INTO insert: — no top-level rows remain.
check('all rows are declared via insert: (documented append semantics; no top-level rows)', topLevelRows.length === 0, `${topLevelRows.length} top-level row(s) remain`);
check('presets (+ client-ui) are declared via insert: (append semantics)', insertedRows.length >= 6, `${insertedRows.length} inserted rows`);

const OWN_PACKAGES = new Set(['@local/vbw-host', '@local/vbw-client-ui']);
function assertChildRows(rows, where) {
	let ok = true;
	const bad = [];
	for (const row of rows) {
		const name = row?.name;
		if (name === 'cordis:group' && Array.isArray(row?.config)) {
			if (!assertChildRows(row.config, `${where}/${row.id ?? '?'}`)) ok = false;
			continue;
		}
		if (name === undefined) continue;
		if (!SHIPPED_PACKAGE_NAMES.has(name) && !OWN_PACKAGES.has(name)) {
			ok = false;
			bad.push(`${where}: ${name}`);
		}
	}
	if (!ok) check(`preset plugin rows reference shipped packages or @local/vbw-* only (${where})`, false, bad.join('; '));
	return ok;
}
let childRefsOk = true;
for (const row of insertedRows) {
	if (row?.name === '@deepseek-ai/dsh-agent-preset' && Array.isArray(row?.config?.plugins)) {
		if (!assertChildRows(row.config.plugins, row.id ?? 'preset')) childRefsOk = false;
	}
}
if (childRefsOk) check('preset plugin rows reference shipped packages or @local/vbw-* only', true);
check('no !!js expression beyond the documented win32 pwsh gating', patchRaw.split('!!js').length - 1 === insertedRows.filter((row) => row?.config?.plugins?.some((p) => p?.id === 'tool-pwsh')).length, 'one !!js per preset carrying tool-pwsh');

// ── 3. Required rows ─────────────────────────────────────────────────────────
check('client-ui row present inside insert: (first row, HARDEN-6)', insertedRows.length > 0 && insertedRows[0]?.id === 'vbw-client-ui' && insertedRows[0]?.name === '@local/vbw-client-ui');

const PRESET_SPECS = [
	{ rowId: 'preset-vbw-browser-explorer', presetId: 'vbw-browser-explorer', order: 20 },
	{ rowId: 'preset-vbw-ui-inspector', presetId: 'vbw-ui-inspector', order: 21 },
	{ rowId: 'preset-vbw-frontend-developer', presetId: 'vbw-frontend-developer', order: 22 },
	{ rowId: 'preset-vbw-browser-tester', presetId: 'vbw-browser-tester', order: 23 },
	{ rowId: 'preset-vbw-qa-reviewer', presetId: 'vbw-qa-reviewer', order: 24 }
];
const presetRows = new Map();
for (const spec of PRESET_SPECS) {
	const row = insertedRows.find((candidate) => candidate?.id === spec.rowId && candidate?.name === '@deepseek-ai/dsh-agent-preset');
	presetRows.set(spec.presetId, row);
}
check('all 5 preset rows present with correct agent-preset ids and order', PRESET_SPECS.every((spec) => {
	const row = presetRows.get(spec.presetId);
	return row?.config?.id === spec.presetId && row?.config?.order === spec.order;
}), PRESET_SPECS.map((spec) => `${presetRows.get(spec.presetId)?.config?.id ?? 'MISSING'}@${presetRows.get(spec.presetId)?.config?.order ?? '-'}`).join(', '));

const REQUIRED_SHARED = ['persona', 'agent-instructions', 'time-context'];
check('every preset mounts persona, agent-instructions(maxBytes 65536), time-context', PRESET_SPECS.every((spec) => {
	const plugins = presetRows.get(spec.presetId)?.config?.plugins ?? [];
	const has = (id) => plugins.some((plugin) => plugin?.id === id);
	return REQUIRED_SHARED.every(has)
		&& plugins.find((plugin) => plugin?.id === 'agent-instructions')?.config?.maxBytes === 65536
		&& typeof plugins.find((plugin) => plugin?.id === 'persona')?.config?.prefix === 'string'
		&& plugins.find((plugin) => plugin?.id === 'persona')?.config?.prefix.length > 200;
}));

// ── 4. Tool policy per preset ────────────────────────────────────────────────
const FS_READONLY = { read: true, readImage: true, write: false, edit: false, applyPatch: false };
const FS_FULL = { read: true, write: true, edit: true, applyPatch: false };
const PWSH_GATED = 'process.platform !== \'win32\'';

function pluginOf(presetId, id) {
	return (presetRows.get(presetId)?.config?.plugins ?? []).find((plugin) => plugin?.id === id);
}
function groupChildren(presetId, groupId) {
	const group = pluginOf(presetId, groupId);
	return Array.isArray(group?.config) ? group.config : [];
}

for (const presetId of ['vbw-browser-explorer', 'vbw-ui-inspector', 'vbw-qa-reviewer']) {
	const fsRow = pluginOf(presetId, 'tool-fs');
	check(`${presetId}: tool-fs is read-only`, fsRow !== undefined && JSON.stringify(fsRow.config) === JSON.stringify(FS_READONLY), JSON.stringify(fsRow?.config ?? null));
}
check('vbw-frontend-developer: tool-fs is read+write+edit without applyPatch', JSON.stringify(pluginOf('vbw-frontend-developer', 'tool-fs')?.config) === JSON.stringify(FS_FULL), JSON.stringify(pluginOf('vbw-frontend-developer', 'tool-fs')?.config ?? null));
check('tool-pwsh appears only with the win32 gating expression', ['vbw-frontend-developer', 'vbw-browser-tester'].every((presetId) => pluginOf(presetId, 'tool-pwsh')?.disabled === PWSH_GATED)
	&& ['vbw-browser-explorer', 'vbw-ui-inspector', 'vbw-qa-reviewer'].every((presetId) => pluginOf(presetId, 'tool-pwsh') === undefined));
check('tool-jobs only on frontend-developer and browser-tester', ['vbw-frontend-developer', 'vbw-browser-tester'].every((presetId) => pluginOf(presetId, 'tool-jobs')?.name === '@deepseek-ai/dsh-tool-jobs')
	&& ['vbw-browser-explorer', 'vbw-ui-inspector', 'vbw-qa-reviewer'].every((presetId) => pluginOf(presetId, 'tool-jobs') === undefined));
check('tool-web fetch only on explorer, ui-inspector, qa-reviewer', ['vbw-browser-explorer', 'vbw-ui-inspector', 'vbw-qa-reviewer'].every((presetId) => pluginOf(presetId, 'tool-web')?.config?.fetch === true)
	&& ['vbw-frontend-developer', 'vbw-browser-tester'].every((presetId) => pluginOf(presetId, 'tool-web') === undefined));

const vbwCarriers = PRESET_SPECS.map((spec) => spec.presetId).filter((presetId) => presetId !== 'vbw-qa-reviewer');
// SEC-11: explorer/inspector mount the read/drive subset WITHOUT vbw_test_run;
// frontend-developer/tester keep the full default set (no `tools:` key).
const VBW_DRIVE_SET = ['vbw_status', 'vbw_session_open', 'vbw_navigate', 'vbw_screenshot', 'vbw_read_text', 'vbw_inventory', 'vbw_element_at', 'vbw_map_source', 'vbw_fetch_annotations', 'vbw_ui_url'];
const EXPECTED_TOOLS = {
	'vbw-browser-explorer': VBW_DRIVE_SET,
	'vbw-ui-inspector': VBW_DRIVE_SET,
	'vbw-frontend-developer': null, // default = all 11
	'vbw-browser-tester': null // default = all 11 (incl. vbw_test_run)
};
check('vbw-tools group row carries vbw-host (brokerRoot + autoSpawn + expected tools subset) exactly where required', vbwCarriers.every((presetId) => {
	const host = groupChildren(presetId, 'vbw-tools').find((child) => child?.id === 'vbw-host');
	const expected = EXPECTED_TOOLS[presetId];
	const tools = host?.config?.tools;
	const toolsOk = expected === null
		? tools === undefined
		: Array.isArray(tools) && JSON.stringify([...tools].sort()) === JSON.stringify([...expected].sort()) && !tools.includes('vbw_test_run');
	return host?.name === '@local/vbw-host' && typeof host?.config?.brokerRoot === 'string' && host?.config?.autoSpawn === true && toolsOk;
}) && pluginOf('vbw-qa-reviewer', 'vbw-tools') === undefined);

// ── 5. package.json manifests ────────────────────────────────────────────────
let manifests;
try {
	manifests = {
		root: JSON.parse(readText('package.json')),
		host: JSON.parse(readText('packages/vbw-host/package.json')),
		clientUi: JSON.parse(readText('packages/vbw-client-ui/package.json'))
	};
	check('all package.json files parse', true);
} catch (error) {
	manifests = null;
	check('all package.json files parse', false, String(error));
}
if (manifests) {
	check('bundle manifest: name/private/type + dsh.bundle.patch', manifests.root.name === '@local/vbw-bundle' && manifests.root.private === true && manifests.root.type === 'module' && manifests.root.dsh?.bundle?.patch === './cordis.patch.yml');
	check('bundle deps link the two subpackages with the link: protocol', manifests.root.dependencies?.['@local/vbw-host'] === 'link:packages/vbw-host' && manifests.root.dependencies?.['@local/vbw-client-ui'] === 'link:packages/vbw-client-ui');
	check('bundle devDependencies include yaml (validator)', typeof manifests.root.devDependencies?.yaml === 'string');
	check('host package manifest: name/type/main', manifests.host.name === '@local/vbw-host' && manifests.host.type === 'module' && manifests.host.main === 'lib/index.js');
	check('client-ui package manifest: name/type/main + dsh.client{platform:web}', manifests.clientUi.name === '@local/vbw-client-ui' && manifests.clientUi.type === 'module' && manifests.clientUi.main === 'lib/index.js' && manifests.clientUi.dsh?.client?.platform === 'web' && Array.isArray(manifests.clientUi.dsh?.client?.inject));
	check('client-ui exports ./client -> lib/client.js', manifests.clientUi.exports?.['./client'] === './lib/client.js');
}

// ── 6. node --check on all lib JS ────────────────────────────────────────────
function listLibFiles(relative) {
	const dir = path.join(BUNDLE_ROOT, relative);
	const found = [];
	if (!fs.existsSync(dir)) return found;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...listLibFiles(path.join(relative, entry.name)));
		else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
	}
	return found;
}
const libFiles = [...listLibFiles('packages/vbw-host/lib'), ...listLibFiles('packages/vbw-client-ui/lib')];
check('lib JS files exist for both packages', libFiles.length >= 4, libFiles.map((file) => path.relative(BUNDLE_ROOT, file)).join(', '));
let syntaxOk = true;
const syntaxFails = [];
for (const file of libFiles) {
	const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
	if (result.status !== 0) {
		syntaxOk = false;
		syntaxFails.push(`${path.relative(BUNDLE_ROOT, file)}: ${result.stderr.trim().split('\n')[0]}`);
	}
}
check('every lib/*.js passes node --check', syntaxOk, syntaxFails.join('; ') || `${libFiles.length} files checked with ${process.execPath}`);

// ── 7. client.js wrapper byte-pattern ────────────────────────────────────────
const clientSource = readText('packages/vbw-client-ui/lib/client.js');
const wrapperHead = 'window.__ModuleLoader__.load({';
check('client.js wrapped by window.__ModuleLoader__.load (byte-pattern head)', clientSource.startsWith(wrapperHead));
check('client.js registration id is @local/vbw-client-ui', clientSource.includes('id: "@local/vbw-client-ui"'));
check('client.js factory receives require', clientSource.includes('factory: (require) => {'));
check('client.js factory returns module.exports and exports apply/inject', clientSource.includes('return module.exports;') && clientSource.includes('exports.apply = apply;') && clientSource.includes('exports.inject = inject;'));
check('client.js wrapper closes with })', clientSource.trimEnd().endsWith('});'));
check('client.js uses React.createElement only (no JSX)', clientSource.includes('const e = react.createElement;') && !/[,{(\[]\s*</.test(clientSource.replace(/^\s*\/\/.*$/gm, '')));

// ── 8. Host plugin tool contract ─────────────────────────────────────────────
const hostIndex = readText('packages/vbw-host/lib/index.js');
const hostCode = hostIndex.replace(/^\s*\/\/.*$/gm, ''); // count code, not comments
const TOOL_NAMES = ['vbw_status', 'vbw_session_open', 'vbw_navigate', 'vbw_screenshot', 'vbw_read_text', 'vbw_inventory', 'vbw_element_at', 'vbw_map_source', 'vbw_fetch_annotations', 'vbw_test_run', 'vbw_ui_url'];
// SEC-11: buildTools defines all 11 tools; apply() registers the configured subset
// (config.tools, default all) through ctx.tools.register.
check('host defines all 11 tools and registers the config.tools subset via ctx.tools.register', TOOL_NAMES.every((tool) => hostCode.includes(`name: '${tool}'`)) && hostCode.split('= defineTool({').length - 1 === 11 && hostCode.includes('ctx.tools.register(tools[') && hostCode.includes('config?.tools'), `${hostCode.split('= defineTool({').length - 1} tool definitions`);
const executes = hostCode.split('async execute(').length - 1;
const signalUses = hostCode.split('exec.signal').length - 1;
check('every execute() honors exec.signal', executes === 11 && signalUses >= 11, `${executes} execute bodies, ${signalUses} exec.signal references`);
check('host resolves defineTool via the local replica module', readText('packages/vbw-host/lib/define-tool.js').includes('export const defineTool') && hostIndex.includes("from './define-tool.js'"));
check('broker discovery reads the state file and spawns src/server.mjs when autoSpawn', readText('packages/vbw-host/lib/broker-client.js').includes('broker.json') && readText('packages/vbw-host/lib/broker-client.js').includes("'src/server.mjs'"));

// ── 9. AGENTS.md covers the roles ────────────────────────────────────────────
const agentsDoc = readText('AGENTS.md');
check('AGENTS.md documents all 5 vbw-* roles', PRESET_SPECS.every((spec) => agentsDoc.includes(spec.presetId)), 'mission / allowed tools / path ownership / escalation / refuse sections');

// ── summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) console.log(`ALL CHECKS PASSED (${process.platform}, node ${process.version})`);
else console.log(`${failures} CHECK(S) FAILED (${process.platform}, node ${process.version})`);
process.exit(failures === 0 ? 0 : 1);
