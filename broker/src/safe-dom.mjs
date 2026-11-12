/**
 * Safe DOM inventory — element-at, slug refs, delta protocol.
 *
 * The inventory selector list, slug-ref minting (with -N suffixes that are never rewound),
 * the delta protocol (added/changed/removed/rebound/same), the rebind-affinity ladder
 * (>= 0.6, strictly best candidate) and the "navigation retires all refs" rule are ported
 * from the Hermes Agent annotate/act-in-page engine.
 *
 * Portions derived from NousResearch/hermes-agent @ 3c79700a6ccf098cd32eeab73c95c2514b2055e3, MIT.
 * (The Liveblocks/Apache-2.0 cursor geometry from watch-in-page.ts is NOT used here.)
 *
 * Security invariants enforced here (broker-api.md §Security):
 * - form-field *values* are never returned: text-like inputs/textareas/contenteditable
 *   contribute NO `value` at all (only checkbox/radio state or a static select option label);
 * - `href` is reduced to origin+pathname (no query, no fragment, no credentials);
 * - text snippets are capped at 120 chars, whitespace-collapsed;
 * - sensitive-looking fields (password / credit-card-ish) carry `sensitive:true`;
 * - all label/name/value strings pass the secret-pattern redaction filter server-side.
 */
import { DEFAULTS } from './config.mjs';
import { err } from './errors.mjs';
import { redactText, compilePatterns } from './perception.mjs';
import { sourceFromFiberRaw } from './fiber.mjs';

export const REBIND_AFFINITY_BAR = 0.6; // Hermes rebind threshold (ported)

/**
 * Installed into every session context via addInitScript. Self-contained, idempotent,
 * no free identifiers. Defines window.__vbw with the element registry (vid <-> WeakRef),
 * the visibility filter, safe-metadata collection, the React fiber walk and the survey.
 */
export const INIT_PAGE_SCRIPT = String.raw`
(() => {
  const VBW = (window.__vbw = window.__vbw || {});
  if (VBW.ready) return;
  VBW.ready = true;
  VBW.reg = new Map();      // vid -> WeakRef<Element>
  VBW.elMap = new WeakMap(); // Element -> vid
  VBW.next = 1;

  VBW.vidFor = function (el) {
    let v = VBW.elMap.get(el);
    if (v === undefined) {
      v = VBW.next++;
      VBW.elMap.set(el, v);
      VBW.reg.set(v, typeof WeakRef === 'function' ? new WeakRef(el) : { deref: function () { return el; } });
    }
    return v;
  };
  VBW.byId = function (vid) {
    const ref = VBW.reg.get(Number(vid));
    if (!ref) return null;
    const el = ref.deref ? ref.deref() : null;
    return el && el.isConnected ? el : null;
  };

  // Inventory selector list (verbatim port from Hermes act-in-page.ts, MIT).
  VBW.SELECTORS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, label[for], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [role="option"], [role="combobox"], [role="searchbox"], [role="textbox"], [contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';

  VBW.visible = function (el) {
    try {
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    } catch (e) { /* older engines */ }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  VBW.roleOf = function (el) {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    if (el.tagName === 'INPUT') return 'input:' + (el.type || 'text');
    return el.tagName.toLowerCase();
  };

  VBW.safeValue = function (el) {
    // SECURITY: text-like form fields never contribute a value. Checkbox/radio expose only
    // their checked state; select exposes only the static selected option label.
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'checked' : 'unchecked';
    if (el.tagName === 'SELECT') {
      const o = el.selectedOptions && el.selectedOptions[0];
      return o ? String(o.label || o.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    }
    return '';
  };

  VBW.textSnippet = function (el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent && n.textContent.trim()) t += ' ' + n.textContent;
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (!t) t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 120);
  };

  VBW.labelFor = function (el) {
    const q = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    let t = q(el.getAttribute('aria-label'));
    if (t) return t.slice(0, 160);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      t = q(lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent || '').join(' '));
      if (t) return t.slice(0, 160);
    }
    if (el.labels && el.labels.length) { t = q(el.labels[0].textContent); if (t) return t.slice(0, 160); }
    t = q(el.getAttribute('placeholder')); if (t) return t.slice(0, 160);
    t = q(el.getAttribute('title')); if (t) return t.slice(0, 160);
    if (el.tagName === 'LABEL' && el.htmlFor) {
      const c = document.getElementById(el.htmlFor);
      if (c) {
        t = q(c.getAttribute('aria-label')); if (t) return t.slice(0, 160);
        const cv = VBW.safeValue(c); if (cv) return cv;
      }
    }
    t = VBW.textSnippet(el); if (t) return t;
    return VBW.safeValue(el);
  };

  VBW.selectorOf = function (el) {
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    const tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid="' + tid + '"]';
    return null;
  };

  VBW.sensitiveOf = function (el) {
    if (el.tagName === 'INPUT' && el.type === 'password') return true;
    const ac = el.getAttribute && el.getAttribute('autocomplete');
    if (ac && /cc-|card/i.test(ac)) return true;
    if (el.tagName === 'INPUT' && /(text|email|search|tel|number|textarea)/.test(String(el.type || 'text')) === false && el.tagName !== 'TEXTAREA') {
      // non-text inputs (checkbox/radio/button) are not sensitive by name
    }
    const haystack = [el.id, el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.htmlFor]
      .filter(Boolean).join(' ').toLowerCase();
    return /(pass(word)?|pwd|ccnum|cc-number|card(number)?|cvv|cvc|csc|ssn|socialsecurity|secret|token|apikey|api_key)/.test(haystack);
  };

  VBW.hrefOf = function (el) {
    if (el.tagName === 'A' && el.getAttribute('href') != null) {
      try {
        const u = new URL(el.href, location.href);
        return u.origin + u.pathname; // SECURITY: origin+pathname only
      } catch (e) { /* relative junk */ }
    }
    return null;
  };

  VBW.safeMeta = function (el) {
    const role = VBW.roleOf(el);
    const label = VBW.labelFor(el);
    const name = VBW.textSnippet(el);
    const value = VBW.safeValue(el);
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    const r = el.getBoundingClientRect();
    const meta = {
      role,
      label,
      name: name || undefined,
      value: value || undefined,
      disabled: disabled ? true : undefined,
      selector: VBW.selectorOf(el) || undefined,
      box: {
        x: Math.round(r.left * 100) / 100,
        y: Math.round(r.top * 100) / 100,
        width: Math.round(r.width * 100) / 100,
        height: Math.round(r.height * 100) / 100,
      },
      sig: label + '\u0001' + value + '\u0001' + (disabled ? '1' : '0'),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      testId: el.getAttribute('data-testid') || undefined,
      inputType: el.tagName === 'INPUT' ? String(el.type || 'text') : undefined,
      sensitive: VBW.sensitiveOf(el) ? true : undefined,
      href: VBW.hrefOf(el) || undefined,
    };
    // SECURITY invariants: drop entries the agent cannot tell apart (no label and no value),
    // per the Hermes rule.
    if (!label && !value) return null;
    return meta;
  };

  // React 18 dev builds expose __reactFiber$* keys; walk the owner chain to _debugSource.
  VBW.fiberOf = function (el) {
    try {
      const key = Object.keys(el).find((k) => typeof k === 'string' && k.indexOf('__reactFiber$') === 0);
      if (!key) return null;
      let f = el[key];
      let hop = 0;
      let ownerName = null;
      while (f && hop < 14) {
        const src = f._debugSource || (f.elementType && f.elementType._source) || null;
        const t = f.type;
        const nm = t && (typeof t === 'function' || typeof t === 'object') ? (t.name || null) : null;
        if (nm && !ownerName) ownerName = nm;
        if (src && src.fileName) {
          return { fileName: String(src.fileName), lineNumber: src.lineNumber || null, componentName: nm || ownerName, hop };
        }
        f = f.return;
        hop++;
      }
      return null;
    } catch (e) { return null; }
  };

  VBW.surveyEls = function (max) {
    const out = [];
    const els = Array.prototype.slice.call(document.querySelectorAll(VBW.SELECTORS));
    for (const el of els) {
      if (out.length >= max) break;
      if (!VBW.visible(el)) continue;
      const meta = VBW.safeMeta(el);
      if (!meta) continue;
      out.push(Object.assign({ vid: VBW.vidFor(el) }, meta, { fiber: VBW.fiberOf(el) }));
    }
    return out;
  };

  VBW.elementAt = function (x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const meta = VBW.safeMeta(el);
    const classes = el.classList ? Array.prototype.slice.call(el.classList, 0, 8) : [];
    return Object.assign(
      { vid: VBW.vidFor(el) },
      meta || { role: el.tagName.toLowerCase(), label: '', box: { x: 0, y: 0, width: 0, height: 0 }, sig: '' },
      { fiber: VBW.fiberOf(el), classes }
    );
  };

  VBW.locate = function (spec) {
    // spec: {vid} | {selector} | {x,y}
    let el = null;
    if (spec.vid != null) el = VBW.byId(spec.vid);
    else if (spec.selector) { try { el = document.querySelector(spec.selector); } catch (e) { el = null; } }
    else if (spec.x != null && spec.y != null) el = document.elementFromPoint(spec.x, spec.y);
    if (!el) return null;
    const meta = VBW.safeMeta(el);
    return Object.assign(
      { vid: VBW.vidFor(el) },
      meta || { role: el.tagName.toLowerCase(), label: '', box: { x: 0, y: 0, width: 0, height: 0 }, sig: '' },
      { fiber: VBW.fiberOf(el), classes: el.classList ? Array.prototype.slice.call(el.classList, 0, 8) : [] }
    );
  };
})();
0;
`;

const ROLE_PREFIX = {
  button: 'btn', link: 'lnk', textbox: 'txt', searchbox: 'txt', search: 'txt',
  checkbox: 'chk', radio: 'rad', tab: 'tab', menuitem: 'mi', switch: 'sw',
  option: 'opt', combobox: 'sel', select: 'sel', textarea: 'txt', summary: 'smry',
  label: 'lbl', spinbutton: 'spb', slider: 'sld', progressbar: 'prg',
  treeitem: 'ti', gridcell: 'gc', columnheader: 'ch',
};

/** Server-side ref book: vid <-> ref, slug minting with -N suffixes, never rewound. */
export class RefBook {
  constructor(url) {
    this.url = url;
    this.byVid = new Map(); // vid -> entry {vid, ref, raw, sig}
    this.byRef = new Map(); // ref -> entry
    this.coined = new Map(); // stem -> next suffix
  }

  coin(prefix, stem) {
    const base = `${prefix}-${stem || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || prefix || 'el';
    const n = this.coined.get(base) || 0;
    this.coined.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`; // Hermes: -1, -2 … never rewound
  }

  add(vid, ref, raw) {
    const entry = { vid, ref, raw, sig: raw.sig };
    this.byVid.set(vid, entry);
    this.byRef.set(ref, entry);
    return entry;
  }
}

function clampCap(max) {
  const n = Number(max);
  if (!Number.isFinite(n) || n <= 0) return DEFAULTS.inventoryCap;
  return Math.min(Math.floor(n), DEFAULTS.inventoryCap);
}

const redactions = compilePatterns();

function clean(value) {
  return typeof value === 'string' ? redactText(value, redactions) : { text: value, count: 0 };
}

/** Wire Element exactly per spec (+`sensitive` flag demanded by the security invariants). */
export function buildElement(ref, raw, { extended = false } = {}) {
  const label = clean(raw.label).text;
  const name = raw.name ? clean(raw.name).text : undefined;
  const value = raw.value ? clean(raw.value).text : undefined;
  const el = {
    ref,
    role: raw.role,
    label,
    ...(name ? { name } : {}),
    ...(value ? { value } : {}),
    ...(raw.disabled ? { disabled: true } : {}),
    ...(raw.selector ? { selector: raw.selector } : {}),
    box: raw.box,
    ...(raw.sensitive ? { sensitive: true } : {}),
    ...(extended
      ? {
          tag: raw.tag,
          ...(raw.id ? { id: raw.id } : {}),
          ...(raw.classes && raw.classes.length ? { classes: raw.classes } : {}),
          ...(raw.testId ? { testId: raw.testId } : {}),
          ...(raw.inputType ? { inputType: raw.inputType } : {}),
          ...(raw.href ? { href: raw.href } : {}),
        }
      : {}),
  };
  const src = raw.fiber || null; // normalized wire SourceRef (set by survey/elementAt)
  if (src) el.source = src;
  return el;
}

function redactionCount(parts) {
  let n = 0;
  for (const p of parts) n += clean(p).count;
  return n;
}

/**
 * Rebind affinity (ported, Hermes survey()). Weighted stable-attribute match; threshold
 * REBIND_AFFINITY_BAR = 0.6 and the winner must be strictly better than the runner-up.
 */
export function affinity(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  if (a.testId && a.testId === b.testId) s += 0.3;
  if (a.id && a.id === b.id) s += 0.25;
  if (a.label && a.label === b.label) s += 0.2;
  if (a.href && a.href === b.href) s += 0.1;
  if (a.role === b.role) s += 0.1;
  if (a.tag === b.tag) s += 0.05;
  return Math.min(1, s);
}

function coinStem(raw) {
  return raw.testId || raw.id || raw.label || raw.name || '';
}

function coinPrefix(raw) {
  return ROLE_PREFIX[raw.role] || (raw.role || raw.tag || 'el').replace(/^input:/, 'input-');
}

/**
 * Survey the page and maintain the ref book. Navigation since the last survey retires all
 * refs (Hermes delta rule: handles are never rebound across pages). Delta protocol:
 * pass 1 keeps refs whose element (vid) survived and reports changed label/value/disabled;
 * pass 2 rebinds new nodes to retired-pool refs when affinity >= 0.6 and strictly best,
 * else coins a fresh ref (added). Elements that truly left are `removed`.
 */
export async function survey(session, { max, projectRoot = null } = {}) {
  const page = session.page;
  const cap = clampCap(max);
  const url = page.url();
  const fresh = session.book.url !== url;
  const retiredRefs = fresh ? [...session.book.byRef.keys()] : [];

  const oldBook = session.book;
  if (fresh) session.book = new RefBook(url);
  const book = session.book;

  const raws = await page.evaluate((m) => window.__vbw.surveyEls(m), cap);
  for (const raw of raws) {
    // normalize the page-side fiber hit into the wire SourceRef here (once per element)
    raw.fiber = raw.fiber ? sourceFromFiberRaw(raw.fiber, projectRoot) : null;
  }

  const seenVids = new Set(raws.map((r) => r.vid));
  const elements = [];
  const added = [];
  const changed = [];
  const removed = [];
  const rebound = [];
  let same = 0;
  let redactionHits = 0;

  // Pass 1: survivors
  const pool = [];
  for (const raw of raws) {
    const e = book.byVid.get(raw.vid);
    if (e) {
      const sig = raw.sig;
      if (sig !== e.sig) {
        const prev = e.raw;
        const moved = {};
        if (clean(prev.label).text !== clean(raw.label).text) moved.label = clean(raw.label).text;
        if (clean(prev.value || '').text !== clean(raw.value || '').text) moved.value = clean(raw.value || '').text;
        if (!!prev.disabled !== !!raw.disabled) moved.disabled = raw.disabled ? true : false;
        changed.push({ ref: e.ref, ...moved });
        e.raw = raw;
        e.sig = sig;
      } else {
        same += 1;
        e.raw = raw;
      }
      redactionHits += redactionCount([raw.label, raw.name, raw.value]);
      elements.push(buildElement(e.ref, raw));
    } else {
      pool.push(raw);
    }
  }

  // Pass 2: rebind or coin
  const unmatched = [...oldBook.byVid.values()].filter((e) => !seenVids.has(e.vid) && !fresh);
  for (const raw of pool) {
    let best = null;
    let bestScore = 0;
    let second = 0;
    for (const e of unmatched) {
      const s = affinity(e.raw, raw);
      if (s > bestScore) {
        second = bestScore;
        best = e;
        bestScore = s;
      } else if (s > second) {
        second = s;
      }
    }
    if (best && bestScore >= REBIND_AFFINITY_BAR && bestScore > second) {
      oldBook.byVid.delete(best.vid);
      oldBook.byRef.delete(best.ref);
      book.add(raw.vid, best.ref, raw);
      rebound.push(best.ref);
      redactionHits += redactionCount([raw.label, raw.name, raw.value]);
      elements.push(buildElement(best.ref, raw));
      unmatched.splice(unmatched.indexOf(best), 1);
    } else {
      const ref = book.coin(coinPrefix(raw), coinStem(raw));
      book.add(raw.vid, ref, raw);
      added.push(ref);
      redactionHits += redactionCount([raw.label, raw.name, raw.value]);
      elements.push(buildElement(ref, raw));
    }
  }
  for (const e of unmatched) removed.push(e.ref);

  return {
    url,
    elements,
    retired: retiredRefs,
    delta: { added, changed, removed, rebound, same },
    redactions: redactionHits,
    // HARDEN-5: the internal reboundRefs Map is no longer part of the wire result —
    // consumers rebuild what they need in-process from delta.rebound + elements.
  };
}

/** POST /sessions/:id/element-at — safe metadata + fiber source for the node at x,y. */
export async function elementAt(session, { x, y }, { extendSource, projectRoot } = {}) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw err(400, 'BAD_COORDS', 'x and y must be numbers (CSS px, viewport-relative)');
  }
  const px = Math.round(Number(x) * 100) / 100;
  const py = Math.round(Number(y) * 100) / 100;
  const raw = await session.page.evaluate((p) => window.__vbw.elementAt(p.x, p.y), { x: px, y: py });
  if (!raw) return { found: false };
  raw.fiber = raw.fiber ? sourceFromFiberRaw(raw.fiber, projectRoot) : null;
  let e = session.book.byVid.get(raw.vid);
  if (!e) {
    const ref = session.book.coin(coinPrefix(raw), coinStem(raw));
    e = session.book.add(raw.vid, ref, raw);
  } else {
    e.raw = raw;
  }
  const element = buildElement(e.ref, raw, { extended: true });
  let source = element.source || null;
  let confidence = source ? source.confidence : undefined;
  if (!source && extendSource) {
    const h = await extendSource(raw);
    if (h) {
      source = h;
      confidence = h.confidence;
    }
  }
  const out = { found: true, element };
  if (source) {
    out.source = source;
    out.confidence = confidence;
  }
  return out;
}

/** POST /sessions/:id/elements/resolve — ok | rebound | lost per ref. */
export async function resolveRefs(session, refs) {
  if (!Array.isArray(refs)) throw err(400, 'BAD_REFS', 'refs must be an array of strings');
  const list = refs.map(String).slice(0, 200);
  const surveyResult = await survey(session, {});
  // HARDEN-5: rebuild the rebound view in-process (ref -> element) from the survey's
  // public delta + elements instead of a serialized Map.
  const reboundSet = new Set(surveyResult.delta.rebound);
  const elementByRef = new Map(surveyResult.elements.map((e) => [e.ref, e]));
  const results = list.map((ref) => {
    const e = session.book.byRef.get(ref);
    if (!e) return { ref, status: 'lost' };
    if (reboundSet.has(ref)) return { ref, status: 'rebound', element: elementByRef.get(ref) || null };
    if (session.book.byVid.has(e.vid)) return { ref, status: 'ok', element: buildElement(e.ref, e.raw) };
    return { ref, status: 'lost' };
  });
  return { results };
}
