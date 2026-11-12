/**
 * Highlight overlay injected into the *driven* page (port of the Hermes watch-in-page
 * technique, MIT).
 *
 * Portions derived from NousResearch/hermes-agent @ 3c79700a6ccf098cd32eeab73c95c2514b2055e3, MIT.
 *
 * Technique: a single `<vbw-watch popover="manual">` host joins the top layer (beats any
 * page z-index / <dialog>), gets a CLOSED shadow root (invisible to document.querySelectorAll,
 * page scripts and our own inventory), and is styled exclusively via el.style.setProperty +
 * element.animate() so strict CSP `style-src` cannot break it. A requestAnimationFrame loop
 * re-fits every mark each frame; a mark whose element left the DOM is removed, so marks ride
 * scrolls and never litter. The Liveblocks (Apache-2.0) cursor geometry is NOT ported.
 *
 * Style kinds: "candidate" (1.5px outline, 6 s dwell) | "held" (2px, persists until cleared)
 * | "hit" (2px, 6 s dwell). Targets: element refs or explicit viewport boxes.
 */
import { err } from './errors.mjs';

const OVERLAY_FN = String.raw`
(spec) => {
  const TAG = 'vbw-watch';
  const INK = '#EC008C';

  function ensureHost() {
    let st = window.__vbwOverlay;
    if (st && st.host && st.host.isConnected) return st;
    const existing = document.querySelector(TAG + '[popover]');
    let host = existing;
    if (!host) {
      host = document.createElement(TAG);
      host.setAttribute('popover', 'manual');
      host.setAttribute('aria-hidden', 'true');
      const style = host.style;
      style.setProperty('position', 'fixed');
      style.setProperty('left', '0');
      style.setProperty('top', '0');
      style.setProperty('width', '0');
      style.setProperty('height', '0');
      style.setProperty('margin', '0');
      style.setProperty('padding', '0');
      style.setProperty('border', 'none');
      style.setProperty('background', 'transparent');
      style.setProperty('overflow', 'visible');
      style.setProperty('pointer-events', 'none');
      style.setProperty('z-index', '2147483647');
      document.documentElement.appendChild(host);
    }
    try { host.showPopover(); } catch (e) { /* popover unsupported */ }
    const root = host.shadowRoot || host.attachShadow({ mode: 'closed' });
    st = window.__vbwOverlay = { host, root, marks: [], raf: 0 };
    return st;
  }

  function clearAll(st) {
    for (const m of st.marks) { try { m.shell.remove(); } catch (e) {} }
    st.marks = [];
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
  }

  function addMark(st, t) {
    const shell = document.createElement('div');
    const skin = document.createElement('div');
    const ss = shell.style;
    ss.setProperty('position', 'fixed');
    ss.setProperty('left', '0');
    ss.setProperty('top', '0');
    ss.setProperty('width', '0');
    ss.setProperty('height', '0');
    ss.setProperty('pointer-events', 'none');
    ss.setProperty('will-change', 'transform');
    const ks = skin.style;
    ks.setProperty('position', 'absolute');
    ks.setProperty('inset', '0');
    ks.setProperty('box-sizing', 'border-box');
    ks.setProperty('border', (t.style === 'candidate' ? '1.5px' : '2px') + ' solid ' + INK);
    ks.setProperty('border-radius', '3px');
    ks.setProperty('background', 'transparent');
    let cap = null;
    if (t.label) {
      cap = document.createElement('div');
      const cs = cap.style;
      cs.setProperty('position', 'absolute');
      cs.setProperty('left', '0');
      cs.setProperty('top', '-14px');
      cs.setProperty('max-width', '160px');
      cs.setProperty('background', INK);
      cs.setProperty('color', '#ffffff');
      cs.setProperty('font-family', 'system-ui, sans-serif');
      cs.setProperty('font-size', '8px');
      cs.setProperty('font-weight', '700');
      cs.setProperty('line-height', '10px');
      cs.setProperty('letter-spacing', '0.04em');
      cs.setProperty('text-transform', 'uppercase');
      cs.setProperty('padding', '1px 4px');
      cs.setProperty('border-radius', '2px');
      cs.setProperty('white-space', 'nowrap');
      cs.setProperty('overflow', 'hidden');
      cs.setProperty('text-overflow', 'ellipsis');
      cap.textContent = String(t.label).slice(0, 40);
      skin.appendChild(cap);
    }
    shell.appendChild(skin);
    st.root.appendChild(shell);
    const mark = {
      shell,
      skin,
      el: t.vid != null && window.__vbw ? window.__vbw.byId(t.vid) : null,
      box: t.box || null,
      born: performance.now(),
      life: t.style === 'held' ? 0 : 6000,
    };
    try {
      skin.animate(
        [{ opacity: 0.15, transform: 'scale(1.05)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 160, easing: 'ease-out', fill: 'both' }
      );
    } catch (e) { /* web animations unsupported */ }
    st.marks.push(mark);
    return mark;
  }

  function fit(st) {
    const now = performance.now();
    st.marks = st.marks.filter((m) => {
      if (m.life > 0 && now - m.born > m.life) { try { m.shell.remove(); } catch (e) {} return false; }
      let r = null;
      if (m.el) {
        if (!m.el.isConnected) { try { m.shell.remove(); } catch (e) {} return false; }
        r = m.el.getBoundingClientRect();
      } else if (m.box) {
        r = { left: m.box.x, top: m.box.y, width: m.box.width, height: m.box.height };
      }
      if (!r) { try { m.shell.remove(); } catch (e) {} return false; }
      const ts = m.shell.style;
      ts.setProperty('transform', 'translate3d(' + r.left + 'px,' + r.top + 'px,0)');
      ts.setProperty('width', r.width + 'px');
      ts.setProperty('height', r.height + 'px');
      return true;
    });
    if (st.marks.length === 0) { st.raf = 0; return; }
    st.raf = requestAnimationFrame(() => fit(st));
  }

  const st = ensureHost();
  if (spec.clear) {
    clearAll(st);
    return { ok: true, cleared: true, attached: 0, missing: [] };
  }
  const missing = [];
  let attached = 0;
  for (const t of spec.targets || []) {
    const m = addMark(st, t);
    if (t.vid != null && !m.el) {
      try { m.shell.remove(); } catch (e) {}
      st.marks.pop();
      missing.push(t.ref || ('vid:' + t.vid));
    } else {
      attached += 1;
    }
  }
  try { st.host.showPopover(); } catch (e) {}
  if (!st.raf && st.marks.length) st.raf = requestAnimationFrame(() => fit(st));
  return { ok: true, attached, missing };
}`;

const DWELL_MS = 6000; // Hermes candidate/hit dwell

/**
 * POST /sessions/:id/highlight { refs?, boxes?, label?, style?, clear? }
 * resolveVid maps a ref to the page-realm vid from the session ref book.
 */
export async function highlight(session, { refs, boxes, label, style, clear } = {}, resolveVid) {
  const kind = ['candidate', 'held', 'hit'].includes(style) ? style : 'candidate';
  const targets = [];
  const refList = Array.isArray(refs) ? refs.map(String).slice(0, DEFAULT_OVERLAY_CAP) : [];
  for (const ref of refList) {
    const vid = resolveVid(ref);
    if (vid != null) targets.push({ vid, style: kind, label: label || ref });
    else targets.push({ ref, style: kind, label: label || ref });
  }
  const boxList = Array.isArray(boxes) ? boxes.slice(0, Math.max(0, DEFAULT_OVERLAY_CAP - targets.length)) : [];
  for (const [i, b] of boxList.entries()) {
    const box = { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) };
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) {
      throw err(400, 'BAD_BOX', `boxes[${i}] must contain numeric x, y, width, height`);
    }
    targets.push({ box, style: kind, label: label || undefined });
  }
  if (!clear && targets.length === 0) {
    throw err(400, 'NO_TARGETS', 'provide refs[], boxes[], or clear:true');
  }
  if (targets.length > DEFAULT_OVERLAY_CAP) throw err(400, 'TOO_MANY_TARGETS', `max ${DEFAULT_OVERLAY_CAP} marks`);
  return session.page.evaluate(OVERLAY_FN_COMPILED, { targets, clear: clear === true, dwell: DWELL_MS });
}

const DEFAULT_OVERLAY_CAP = 600; // Hermes maxMarks (on-screen field)

// OVERLAY_FN is a raw string; page.evaluate(string) treats it as an EXPRESSION (never called
// with args), so compile it into a real function object once — Playwright then calls it.
const OVERLAY_FN_COMPILED = eval(`(${OVERLAY_FN})`);
