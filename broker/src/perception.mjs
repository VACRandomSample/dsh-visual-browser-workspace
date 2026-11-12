/**
 * Perception: JPEG/PNG frames, clipped/element screenshots with optional save-to-disk,
 * paged visible-text reading with secret-pattern redaction.
 *
 * Redaction (broker-api.md security invariant 3): 16-digit runs, sk-… keys, Bearer …,
 * password=… — replaced with «redacted», hit count returned to the caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULTS, SHOTS_DIR, ensureDirs } from './config.mjs';
import { err } from './errors.mjs';

export const DEFAULT_REDACT_PATTERNS = [
  { name: 'card16', source: '\\b\\d{16}\\b' },
  { name: 'card-grouped', source: '\\b(?:\\d{4}[ -]){3}\\d{4}\\b' },
  { name: 'api-key', source: '\\bsk-[A-Za-z0-9_-]{8,}\\b' },
  { name: 'bearer', source: '\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}' },
  { name: 'password', source: '\\bpassword=\\S+', flags: 'gi' },
  // SEC-3 coverage extensions (JWT, cloud/vendor keys, generic hex runs):
  { name: 'jwt', source: '\\beyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]*' },
  { name: 'aws-access-key', source: '\\bAKIA[0-9A-Z]{16}\\b' },
  { name: 'github-token', source: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b' },
  { name: 'github-fine-grained', source: '\\bgithub_pat_[A-Za-z0-9_]{22,}\\b' },
  { name: 'slack-token', source: '\\bxox[bpars]-[A-Za-z0-9-]{10,}\\b' },
  { name: 'google-api-key', source: '\\bAIza[0-9A-Za-z_-]{35}\\b' },
  { name: 'hex32', source: '\\b[0-9a-f]{32,}\\b', flags: 'gi' },
];

/**
 * Patterns come from VBW_REDACT_PATTERNS (comma-separated regex sources, case-insensitive
 * flag `i` allowed via trailing `(?i)`) or the defaults above.
 */
export function compilePatterns(envVar = process.env.VBW_REDACT_PATTERNS) {
  if (envVar && envVar.trim()) {
    return envVar.split(',').map((s) => s.trim()).filter(Boolean).map((source) => {
      let flags = 'g';
      let src = source;
      if (src.endsWith('(?i)')) {
        flags = 'gi';
        src = src.slice(0, -4);
      }
      return { source: src, flags };
    });
  }
  return DEFAULT_REDACT_PATTERNS.map((p) => ({ source: p.source, flags: p.flags || 'g' }));
}

/** Replace every pattern hit with «redacted»; returns the new text and the hit count. */
export function redactText(text, patterns = compilePatterns()) {
  if (typeof text !== 'string' || text === '') return { text: String(text ?? ''), count: 0 };
  let count = 0;
  let out = text;
  for (const p of patterns) {
    let re;
    try {
      re = new RegExp(p.source, p.flags);
    } catch {
      continue; // a broken configured pattern must never break reads
    }
    out = out.replace(re, () => {
      count += 1;
      return '«redacted»';
    });
  }
  return { text: out, count };
}

/**
 * SEC-3: redact a short metadata string (page title, session title) ONLY when it
 * actually matches a secret pattern — titles are never blanket-redacted.
 */
export function redactIfMatch(text, patterns = compilePatterns()) {
  if (typeof text !== 'string' || text === '') return text;
  for (const p of patterns) {
    let re;
    try {
      re = new RegExp(p.source, p.flags);
    } catch {
      continue;
    }
    if (re.test(text)) return redactText(text, patterns).text;
  }
  return text;
}

function clampQuality(q, type) {
  if (type === 'png') return undefined;
  const n = Number(q);
  if (!Number.isFinite(n)) return DEFAULTS.frameQuality;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/** Viewport screenshot for GET /sessions/:id/frame.jpg|.png (Cache-Control: no-store). */
export async function frame(session, { ext = 'jpg', quality } = {}) {
  const type = ext === 'png' ? 'png' : 'jpeg';
  const buffer = await session.page.screenshot({
    type,
    quality: clampQuality(quality, type),
    fullPage: false,
  });
  return { buffer, contentType: type === 'png' ? 'image/png' : 'image/jpeg' };
}

function validClip(clip) {
  if (clip == null) return null;
  const { x, y, width, height } = clip;
  for (const [k, v] of Object.entries({ x, y, width, height })) {
    if (!Number.isFinite(Number(v)) || Number(v) < 0) {
      throw err(400, 'BAD_CLIP', `clip.${k} must be a non-negative number`);
    }
  }
  if (Number(width) < 1 || Number(height) < 1) throw err(400, 'BAD_CLIP', 'clip.width/height must be >= 1');
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

/**
 * POST /sessions/:id/screenshot { fullPage?, clip?, elementSelector?, format?, quality?, save? }
 * -> { dataUrl, file? } — file set when save:true, stored under _vbw\state\screenshots\.
 */
export async function screenshot(session, body = {}) {
  const format = body.format === 'png' ? 'png' : 'jpeg';
  const quality = clampQuality(body.quality, format);
  const clip = validClip(body.clip);
  let buffer;
  if (body.elementSelector) {
    if (typeof body.elementSelector !== 'string') throw err(400, 'BAD_SELECTOR', 'elementSelector must be a string');
    const locator = session.page.locator(body.elementSelector).first();
    try {
      await locator.waitFor({ state: 'attached', timeout: 5_000 });
    } catch {
      throw err(404, 'ELEMENT_NOT_FOUND', `no element matches ${JSON.stringify(body.elementSelector)} (5s wait)`);
    }
    buffer = await locator.screenshot({ type: format, quality, timeout: 10_000 });
  } else {
    buffer = await session.page.screenshot({
      type: format,
      quality,
      fullPage: body.fullPage === true,
      ...(clip ? { clip, fullPage: false } : {}),
    });
  }
  const dataUrl = `data:image/${format === 'png' ? 'png' : 'jpeg'};base64,${buffer.toString('base64')}`;
  let file = null;
  if (body.save === true) {
    ensureDirs();
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    file = `${stamp}-${crypto.randomBytes(4).toString('hex')}.${format === 'png' ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(SHOTS_DIR, file), buffer);
  }
  return { dataUrl, ...(file ? { file } : {}) };
}

/**
 * POST /sessions/:id/read-text { start?, count? (chars, default 4000) } -> paged visible
 * text (document.body.innerText — rendered text only). The returned slice passes the
 * redaction filter; `redactions` counts hits within the slice.
 */
export async function readText(session, body = {}) {
  const total = await session.page.evaluate(() => (document.body && document.body.innerText) || '');
  const totalChars = total.length;
  let start = Number.isFinite(Number(body.start)) ? Math.floor(Number(body.start)) : 0;
  if (start < 0) start = 0;
  if (start > totalChars) start = totalChars;
  let count = Number.isFinite(Number(body.count)) ? Math.floor(Number(body.count)) : 4000;
  if (count <= 0) count = 4000;
  const slice = total.slice(start, start + count);
  const { text, count: hits } = redactText(slice);
  return {
    url: session.page.url(),
    // SEC-3: the page title passes the same secret filter, but only when it matches
    // a pattern (never blanket-redacted).
    title: redactIfMatch(await session.page.title()),
    text,
    start,
    end: start + slice.length,
    totalChars,
    redactions: hits,
  };
}
