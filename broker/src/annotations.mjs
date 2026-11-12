/**
 * Annotation store: numbered comment groups persisted under _vbw\state\annotations\
 * as YYYYMMDD-<groupId>.json, a pending queue for the orchestrator tool, and an ack API.
 * Element/region screenshots are captured by the broker when the caller does not supply one.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ANN_DIR, ANN_FILES_DIR, ensureDirs } from './config.mjs';
import { err } from './errors.mjs';

const MAX_ITEMS = 50;

function groupIdNow() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}${mm}${ss}-${crypto.randomBytes(3).toString('hex')}`;
}

export function groupFileFor(groupId, createdAt = new Date()) {
  const y = createdAt.getFullYear();
  const m = String(createdAt.getMonth() + 1).padStart(2, '0');
  const d = String(createdAt.getDate()).padStart(2, '0');
  return path.join(ANN_DIR, `${y}${m}${d}-${groupId}.json`);
}

function readGroups() {
  ensureDirs();
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(ANN_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(ANN_DIR, name), 'utf8'));
      g.__file = name;
      out.push(g);
    } catch {
      /* skip corrupt file */
    }
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return out;
}

/**
 * GET /annotations/pending -> { groups: [Group] } (status "pending" only).
 * HARDEN-3: item.screenshot dataUrls are stripped from responses unless
 * `{ includeShots: true }` (?includeShots=1) — screenshot FILES stay referenced via
 * item.screenshotFile; the UI keeps its pins (incl. thumbnails) client-side.
 */
export function listPending({ includeShots = false } = {}) {
  const groups = readGroups().filter((g) => g.status === 'pending');
  return {
    groups: groups.map(({ __file, ...g }) => ({
      ...g,
      ...(Array.isArray(g.items) && !includeShots
        ? { items: g.items.map(({ screenshot, ...it }) => it) }
        : {}),
    })),
  };
}

/** POST /annotations/ack { groupIds } -> { acked: n }; acked groups stay on disk (history). */
export function ackGroups(groupIds) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw err(400, 'BAD_GROUP_IDS', 'groupIds must be a non-empty array');
  }
  const wanted = new Set(groupIds.map(String));
  let acked = 0;
  for (const g of readGroups()) {
    if (wanted.has(String(g.groupId)) && g.status === 'pending') {
      g.status = 'acked';
      g.ackedAt = new Date().toISOString();
      fs.writeFileSync(path.join(ANN_DIR, g.__file), JSON.stringify(g, null, 2), 'utf8');
      acked += 1;
    }
  }
  return { acked };
}

function clampBox(box, viewport) {
  const x = Math.max(0, Math.min(box.x, viewport.width - 2));
  const y = Math.max(0, Math.min(box.y, viewport.height - 2));
  const width = Math.max(2, Math.min(box.width, viewport.width - x));
  const height = Math.max(2, Math.min(box.height, viewport.height - y));
  return { x, y, width, height };
}

async function viewportOf(page) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  return vp;
}

async function captureClip(page, box) {
  const vp = await viewportOf(page);
  const clip = clampBox(box, vp);
  if (clip.width < 2 || clip.height < 2) {
    return page.screenshot({ type: 'png', fullPage: false });
  }
  return page.screenshot({ type: 'png', clip, fullPage: false });
}

/**
 * Scroll the target into view and re-measure. Returns a fresh viewport-relative box or
 * null when the element is gone.
 */
async function elementBox(page, { vid, selector }) {
  return page.evaluate(
    (s) => {
      let el = null;
      if (s.vid != null && window.__vbw) el = window.__vbw.byId(s.vid);
      if (!el && s.selector) {
        try { el = document.querySelector(s.selector); } catch (e) { el = null; }
      }
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const r = el.getBoundingClientRect();
            resolve({ x: r.left, y: r.top, width: r.width, height: r.height });
          });
        });
      });
    },
    { vid, selector }
  );
}

function parseDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw err(400, 'BAD_SCREENSHOT', 'screenshot must be a png/jpeg data URL');
  return { ext: m[1] === 'jpeg' ? 'jpg' : 'png', buffer: Buffer.from(m[2], 'base64') };
}

/**
 * POST /sessions/:id/annotations { items:[{kind:"element"|"region", ref?, selector?, box?,
 * meta?, screenshot?, comment, number?}], context? } -> 201 { groupId, items:[{number,…}] }
 */
export async function createGroup(session, body = {}) {
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw err(400, 'BAD_ITEMS', 'items must be a non-empty array');
  }
  if (body.items.length > MAX_ITEMS) throw err(400, 'TOO_MANY_ITEMS', `max ${MAX_ITEMS} items per group`);
  ensureDirs();
  const groupId = groupIdNow();
  const createdAt = new Date().toISOString();
  const items = [];
  let fileIndex = 0;

  for (const [i, raw] of body.items.entries()) {
    const kind = raw.kind === 'region' ? 'region' : raw.kind === 'element' ? 'element' : null;
    if (!kind) throw err(400, 'BAD_ITEM_KIND', `items[${i}].kind must be "element" or "region"`);
    if (typeof raw.comment !== 'string' || !raw.comment.trim()) {
      throw err(400, 'BAD_COMMENT', `items[${i}].comment is required`);
    }
    const item = {
      number: Number.isFinite(Number(raw.number)) && Number(raw.number) > 0 ? Math.floor(Number(raw.number)) : i + 1,
      kind,
      comment: String(raw.comment).slice(0, 2000),
      ...(raw.ref != null ? { ref: String(raw.ref) } : {}),
      ...(raw.selector != null ? { selector: String(raw.selector) } : {}),
      ...(raw.box ? { box: raw.box } : {}),
      ...(raw.meta && typeof raw.meta === 'object' ? { meta: raw.meta } : {}),
      at: createdAt,
    };

    let pngBuffer = null;
    if (raw.screenshot) {
      const parsed = parseDataUrl(raw.screenshot);
      pngBuffer = parsed.buffer;
    } else if (kind === 'element' && (raw.ref != null || raw.selector != null)) {
      const box = await elementBox(session.page, { vid: raw.ref != null ? session.book.byRef.get(String(raw.ref))?.vid : undefined, selector: raw.selector });
      if (box) {
        pngBuffer = await captureClip(session.page, box);
        item.box = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      }
    } else if (raw.box) {
      const b = raw.box;
      if (![b.x, b.y, b.width, b.height].every((v) => Number.isFinite(Number(v)))) {
        throw err(400, 'BAD_BOX', `items[${i}].box must contain numeric x, y, width, height`);
      }
      pngBuffer = await captureClip(session.page, { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) });
    }
    if (!pngBuffer) {
      // element unresolvable and no screenshot supplied — fall back to the viewport frame
      pngBuffer = await session.page.screenshot({ type: 'png', fullPage: false });
      item.captureFallback = 'viewport';
    }
    const fileName = `${groupId}-${String(item.number).padStart(2, '0')}-${fileIndex++}.png`;
    fs.writeFileSync(path.join(ANN_FILES_DIR, fileName), pngBuffer);
    item.screenshotFile = `annotations/files/${fileName}`; // relative to _vbw\state\
    item.screenshot = `data:image/png;base64,${pngBuffer.toString('base64')}`;
    items.push(item);
  }

  const group = {
    groupId,
    createdAt,
    status: 'pending',
    session: { id: session.id, url: session.page.url() },
    context: body.context && typeof body.context === 'object' ? body.context : null,
    items,
  };
  fs.writeFileSync(groupFileFor(groupId), JSON.stringify(group, null, 2), 'utf8');
  return {
    groupId,
    items: items.map((it) => ({
      number: it.number,
      kind: it.kind,
      comment: it.comment,
      ...(it.ref ? { ref: it.ref } : {}),
      ...(it.selector ? { selector: it.selector } : {}),
      ...(it.box ? { box: it.box } : {}),
      ...(it.captureFallback ? { captureFallback: it.captureFallback } : {}),
      screenshotFile: it.screenshotFile,
    })),
  };
}
