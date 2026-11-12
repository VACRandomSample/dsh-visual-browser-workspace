/**
 * Source mapper (visual-to-code).
 *
 * Ladder (broker-api.md §Source mapping):
 *   1. React fiber: DOM node -> __reactFiber$* key -> fiber owner chain -> _debugSource
 *      (React 18 dev builds). origin:"fiber", confidence 0.9+.
 *   2. Sourcemap refinement: when the page is served by a local dev server (vite), the
 *      transformed module carries an inline base64 sourcemap; a heuristic string hit is
 *      resolved to an exact original line through VLQ decoding. Trivially available only —
 *      any failure silently degrades to the heuristic line number.
 *   3. Heuristic: data-testid / id / class / text grep across <projectRoot>/src with a
 *      confidence score; below 0.5 the mapper returns null ("unreliable", never guesses).
 *
 * Project root resolution: VBW_PROJECT_ROOT env, else the broker-managed dev server that
 * serves the page URL, else a bounded scan of the VBW workspace for a package.json whose
 * dev script binds the served port (closest vite.config.* ancestor heuristic).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, VBW_ROOT, WORKSPACE_ROOT, log } from './config.mjs';
import { err } from './errors.mjs';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.css', '.scss']);
const MAX_SCAN_FILES = 600;
const MAX_FILE_BYTES = 256 * 1024;

/** Normalize a React _debugSource fileName (vite URLs, file:// URLs, @fs paths).
 * SECURITY (invariant 5 + SEC-9): never emit host-user-profile absolute paths —
 * relativize against the project root, falling back to the workspace root; a name
 * that is still absolute outside both roots resolves to null (the caller DROPS the
 * source reference instead of returning a raw host path). Leading-slash dev-server
 * module paths ("/src/main.tsx") normalize to the heuristic style ("src/main.tsx").
 * Returns null when no safe relative name can be produced. */
export function normalizeFileName(rawName, projectRoot = null) {
  let name = String(rawName).split('?')[0].split('#')[0];
  try {
    if (name.startsWith('file://')) name = fileURLToPath(name);
  } catch { /* keep raw */ }
  try {
    name = decodeURIComponent(name);
  } catch { /* keep raw */ }
  if (/^https?:\/\//i.test(name)) {
    try {
      const u = new URL(name);
      let p = u.pathname;
      if (p.startsWith('/@fs/')) p = p.slice('/@fs/'.length);
      name = p;
    } catch { /* keep raw */ }
  }
  name = name.replace(/\\/g, '/');
  const roots = [projectRoot, WORKSPACE_ROOT.replace(/\\/g, '/')].filter(Boolean);
  const lower = name.toLowerCase();
  for (const root of roots) {
    const pr = String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (lower.startsWith(`${pr}/`)) {
      return name.slice(pr.length + 1);
    }
  }
  if (!/^[a-z]:\//i.test(name) && !name.startsWith('/')) return name; // already relative
  // POSIX-absolute (no drive letter): on win32 hosts this can only be a dev-server
  // URL path ("/src/main.tsx") — normalize to the heuristic output style instead of
  // emitting a leading-slash name.
  if (!/^[a-z]:\//i.test(name)) {
    return name.replace(/^\/+/, '') || null;
  }
  // Windows-absolute outside every root: strip to a workspace-style suffix if
  // recognisable, else DROP the name (null) — never return the raw host path.
  const m = /(^|\/)_vbw\/.+$/i.exec(name);
  return m ? m[0].replace(/^\//, '') : null;
}

/**
 * Port of the Hermes fiber result to the wire SourceRef: origin "fiber", confidence 0.95
 * when the debug source sits on the node's own/adjacent fiber (hop <= 2), 0.9 deeper.
 */
export function sourceFromFiberRaw(fiberRaw, projectRoot = null) {
  if (!fiberRaw || !fiberRaw.fileName) return null;
  const fileName = normalizeFileName(fiberRaw.fileName, projectRoot);
  if (!fileName) return null; // SEC-9: absolute host path outside the roots — drop the source
  const hop = Number(fiberRaw.hop) || 0;
  const evidence = ['react-fiber: __reactFiber$ key -> fiber chain -> _debugSource'];
  if (fiberRaw.componentName) evidence.push(`component: ${fiberRaw.componentName}`);
  evidence.push(`owner-hop: ${hop}`);
  return {
    fileName,
    ...(fiberRaw.lineNumber ? { lineNumber: Number(fiberRaw.lineNumber) } : {}),
    ...(fiberRaw.componentName ? { componentName: String(fiberRaw.componentName) } : {}),
    origin: 'fiber',
    confidence: hop <= 2 ? 0.95 : 0.9,
    evidence,
  };
}

function listDirs(dir, depth) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (['node_modules', '.git', 'dist', 'test-results', 'playwright-report', '.vite', 'state'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    out.push(p);
    if (depth > 1) out = out.concat(listDirs(p, depth - 1));
  }
  return out;
}

/**
 * Resolve the project root for a served page URL:
 * env override -> broker-managed dev server registry -> bounded workspace scan on port match.
 */
export function findProjectRoot({ pageUrl, devservers = [] } = {}) {
  if (DEFAULTS.projectRoot) {
    try {
      if (fs.statSync(DEFAULTS.projectRoot).isDirectory()) return DEFAULTS.projectRoot;
    } catch { /* fall through */ }
  }
  let origin = null;
  let port = null;
  try {
    const u = new URL(pageUrl);
    origin = u.origin;
    port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return null;
  }
  for (const d of devservers) {
    try {
      if (new URL(d.url).origin === origin && fs.statSync(d.projectDir).isDirectory()) return d.projectDir;
    } catch { /* next */ }
  }
  // scan VBW_ROOT (depth 2) for a package.json whose dev/preview script binds this port
  const candidates = [VBW_ROOT, ...listDirs(VBW_ROOT, 2)];
  const hits = [];
  for (const dir of candidates) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      if (!fs.statSync(pkgPath).isFile()) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = JSON.stringify(pkg.scripts || {});
      if (scripts.includes(`--port ${port}`) || scripts.includes(`--port=${port}`)) hits.push(dir);
    } catch { /* next */ }
  }
  return hits.length === 1 ? hits[0] : null;
}

function walkSources(root, out = [], depth = 0) {
  if (out.length >= MAX_SCAN_FILES || depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_SCAN_FILES) break;
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'test-results', 'playwright-report', '.vite'].includes(e.name)) continue;
      walkSources(p, out, depth + 1);
    } else if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name).toLowerCase())) {
      try {
        if (fs.statSync(p).size <= MAX_FILE_BYTES) out.push(p);
      } catch { /* next */ }
    }
  }
  return out;
}

function lineOf(haystack, needle) {
  if (!needle) return null;
  const idx = haystack.indexOf(needle);
  if (idx < 0) return null;
  return haystack.slice(0, idx).split('\n').length;
}

function componentNameOf(text, line) {
  const lines = text.split('\n');
  const upTo = lines.slice(0, Math.max(1, line || lines.length)).join('\n');
  const m = [
    /export\s+default\s+function\s+([A-Za-z0-9_$]+)/,
    /(?:function|class)\s+([A-Z][A-Za-z0-9_$]*)/,
    /(?:const|let)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[^=]*)=>/,
  ].map((re) => re.exec(upTo)).filter(Boolean);
  if (m.length) return m[m.length - 1][1];
  return null;
}

// --- sourcemap refinement (trivially-available path) --------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_MAP = new Map([...B64].map((c, i) => [c, i]));

function decodeVlqSegment(segment) {
  const values = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = B64_MAP.get(ch);
    if (digit === undefined) throw new Error('bad vlq char');
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
    } else {
      const negate = value & 1;
      value >>= 1;
      values.push(negate ? (value === 0 ? -0x80000000 : -value) : value);
      shift = 0;
      value = 0;
    }
  }
  return values;
}

/** Decode sourcemap mappings into per-generated-line arrays [genCol, srcIdx, srcLine, srcCol]. */
export function decodeMappings(mappingsStr) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const genLineStr of mappingsStr.split(';')) {
    const lineEntries = [];
    let genCol = 0;
    for (const seg of genLineStr.split(',')) {
      if (!seg) continue;
      const v = decodeVlqSegment(seg);
      genCol += v[0];
      if (v.length >= 4) {
        srcIdx += v[1];
        srcLine += v[2];
        srcCol += v[3];
        lineEntries.push([genCol, srcIdx, srcLine, srcCol]);
      } else {
        lineEntries.push([genCol]);
      }
    }
    lines.push(lineEntries);
  }
  return lines;
}

/** Resolve the original line for a generated (0-based line, col) position. */
export function originalLineFor(map, genLine0, genCol) {
  const entries = map.mappingsDecoded[genLine0];
  if (!entries || entries.length === 0) return null;
  let best = null;
  for (const e of entries) {
    if (e.length >= 4 && e[0] <= genCol) best = e;
  }
  if (!best) best = entries.find((e) => e.length >= 4);
  if (!best) return null;
  const source = map.sources[best[1]] || null;
  return { line: best[2] + 1, source };
}

async function fetchSourcemapForModule(devOrigin, relPath) {
  const url = `${devOrigin.replace(/\/+$/, '')}/${String(relPath).replace(/^\/+/, '')}`;
  const res = await fetch(url, { headers: { accept: '*/*' } });
  if (!res.ok) return null;
  const code = await res.text();
  const tail = code.slice(-8192);
  const m = /\/\/[#@]\s*sourceMappingURL=([^\s]+)\s*$/.exec(tail);
  if (!m) return null;
  let mapUrl = m[1];
  let mapText;
  if (mapUrl.startsWith('data:application/json')) {
    const comma = mapUrl.indexOf(',');
    if (comma < 0) return null;
    const payload = mapUrl.slice(comma + 1);
    mapText = mapUrl.slice(0, comma).includes('base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } else {
    const base = url.replace(/[^/]*$/, '');
    const res2 = await fetch(new URL(mapUrl, base));
    if (!res2.ok) return null;
    mapText = await res2.text();
  }
  const map = JSON.parse(mapText);
  map.mappingsDecoded = decodeMappings(map.mappings || '');
  return { map, generatedCode: code };
}

/**
 * Given a heuristic needle (e.g. `price-current`) and the file that contains it, resolve
 * the exact original line through the dev server's sourcemap of the transformed module.
 * Returns the refined line or null (any failure degrades silently).
 */
export async function refineLineViaSourcemap(devOrigin, relPath, needle) {
  try {
    const { map, generatedCode } = await fetchSourcemapForModule(devOrigin, relPath);
    if (!map) return null;
    const idx = generatedCode.indexOf(needle);
    if (idx < 0) return null;
    const genLine0 = generatedCode.slice(0, idx).split('\n').length - 1;
    const genCol = idx - (generatedCode.lastIndexOf('\n', idx) + 1);
    const pos = originalLineFor(map, genLine0, genCol);
    return pos ? { line: pos.line, source: pos.source } : null;
  } catch {
    return null;
  }
}

// --- heuristic fallback ---------------------------------------------------------------

function tokensFromRaw(raw) {
  const t = {
    testIds: raw.testId ? [String(raw.testId)] : [],
    ids: raw.id ? [String(raw.id)] : [],
    classes: Array.isArray(raw.classes) ? raw.classes.filter((c) => c && !/^css-[0-9a-f]{6,}$/i.test(c)) : [],
    texts: [],
  };
  const text = String(raw.name || raw.label || '').replace(/\s+/g, ' ').trim();
  if (text.length >= 4 && text.length <= 60 && !/^[\d$€£.,:;\s%-]+$/.test(text)) t.texts.push(text);
  return t;
}

/**
 * Grep-based fallback across <projectRoot>/src. Confidence model:
 *   data-testid hit 0.62 · id hit 0.5 · text hit 0.25 · classes 0.15 each (max 3,
 *   only counted when >= 2 classes or combined with other evidence).
 * Below 0.5 → null (unreliable). Ambiguity (two files within 0.15) → confidence *= 0.6.
 */
export async function heuristicMatch(projectRoot, tokens, { devOrigin } = {}) {
  const srcDir = path.join(projectRoot, 'src');
  let files;
  try {
    if (!fs.statSync(srcDir).isDirectory()) return null;
    files = walkSources(srcDir);
  } catch {
    return null;
  }
  let best = null;
  let second = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let score = 0;
    const evidence = [];
    let bestLine = null;
    let bestNeedle = null;
    const rel = path.relative(projectRoot, file).replace(/\\/g, '/');

    for (const tid of tokens.testIds) {
      for (const needle of [`data-testid="${tid}"`, `data-testid: "${tid}"`, `'${tid}'`, `"${tid}"`]) {
        const line = lineOf(text, needle);
        if (line) {
          score += 0.62;
          evidence.push(`data-testid "${tid}" -> ${rel}:${line}`);
          if (!bestLine) { bestLine = line; bestNeedle = tid; }
          break;
        }
      }
    }
    for (const id of tokens.ids) {
      const line = lineOf(text, `id="${id}"`) || lineOf(text, `"${id}"`);
      if (line) {
        score += 0.5;
        evidence.push(`id "${id}" -> ${rel}:${line}`);
        if (!bestLine) { bestLine = line; bestNeedle = id; }
        break;
      }
    }
    let classHits = 0;
    for (const cls of tokens.classes) {
      if (lineOf(text, cls) != null) classHits += 1;
    }
    if (classHits >= 2 || (classHits >= 1 && (score > 0 || tokens.texts.length))) {
      score += 0.15 * Math.min(classHits, 3);
      evidence.push(`classes x${classHits} in ${rel}`);
    }
    for (const tx of tokens.texts) {
      const line = lineOf(text, tx);
      if (line) {
        score += 0.25;
        evidence.push(`text "${tx}" -> ${rel}:${line}`);
        if (!bestLine) { bestLine = line; bestNeedle = tx; }
        break;
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      second = best ? best.score : second;
      best = { file, rel, score, evidence, bestLine, bestNeedle };
    } else if (score > second) {
      second = score;
    }
  }
  if (!best || best.score < 0.5) return null;
  if (second > 0 && best.score - second < 0.15) {
    best.score *= 0.6; // ambiguous between files — dampen, may drop below 0.5
    best.evidence.push(`ambiguous: runner-up score ${second.toFixed(2)}`);
  }
  if (best.score < 0.5) return null;

  let lineNumber = best.bestLine || null;
  if (devOrigin && best.bestNeedle) {
    const refined = await refineLineViaSourcemap(devOrigin, best.rel, best.bestNeedle);
    if (refined && refined.line) {
      evidence_push(best.evidence, `sourcemap-refined line ${refined.line} via ${devOrigin}/${best.rel}`);
      lineNumber = refined.line;
    }
  }
  let text;
  try {
    text = fs.readFileSync(best.file, 'utf8');
  } catch {
    text = '';
  }
  const componentName = text ? componentNameOf(text, lineNumber) : null;
  return {
    fileName: best.rel,
    ...(lineNumber ? { lineNumber } : {}),
    ...(componentName ? { componentName } : {}),
    origin: 'heuristic',
    confidence: Math.min(1, Number(best.score.toFixed(2))),
    evidence: best.evidence,
  };
}

function evidence_push(arr, s) {
  if (arr.length < 8) arr.push(s);
}

/** Resolve a target element (ref | selector | x,y) and run the mapping ladder. */
export async function mapSource(session, { ref, selector, x, y } = {}, { projectRoot, devOrigin } = {}) {
  const spec = {};
  if (ref != null) {
    const e = session.book.byRef.get(String(ref));
    if (!e) return { match: null };
    spec.vid = e.vid;
  } else if (selector != null) {
    spec.selector = String(selector);
  } else if (x != null && y != null) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      throw err(400, 'BAD_COORDS', 'x and y must be numbers (CSS px, viewport-relative)');
    }
    spec.x = Number(x);
    spec.y = Number(y);
  } else {
    throw err(400, 'BAD_TARGET', 'provide one of ref, selector, or x+y');
  }
  const raw = await session.page.evaluate((s) => window.__vbw.locate(s), spec);
  if (!raw) return { match: null };

  const fiber = raw.fiber ? sourceFromFiberRaw(raw.fiber, projectRoot) : null;
  if (fiber) return { match: fiber };

  if (!projectRoot) return { match: null };
  const tokens = tokensFromRaw(raw);
  try {
    const match = await heuristicMatch(projectRoot, tokens, { devOrigin });
    if (match && match.confidence >= 0.5) return { match };
  } catch (e) {
    log('heuristic match failed:', e.message);
  }
  return { match: null };
}
