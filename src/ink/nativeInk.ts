import { platform } from '../platform';
import type { NativeInkConfig, NativeStroke } from '../platform/types';

/*
 * Android: the stroke the S Pen is writing is drawn by a native low-latency layer above the WebView
 * (NativeInk.java), which shows it without the delay of the WebView's rendering. The page still
 * decides what a pen contact does. For a stroke it takes the points the layer sends when the pen
 * lifts, so the stored stroke is exactly the one that was shown, and reports when the page shows it
 * itself; the layer then clears. Contacts that are no stroke (a click, a button) are rejected.
 */

const bridge = platform.nativeInk;
/** Longest wait for the points of a finished stroke before the page uses its own. */
const WAIT_MS = 300;
/** Distance (CSS px) within which a stroke's first point names the pointerdown position. */
const MATCH = 2;
/** The layer clears itself shortly after the page shows its strokes. */
const ACTIVE_MS = 1500;

let available = false;
let config: NativeInkConfig | null = null;
let sent = '';
let activeUntil = 0;
const arrived: { stroke: NativeStroke; t: number }[] = [];
const waiting: { x: number; y: number; resolve(s: NativeStroke): void }[] = [];
const rejected: { x: number; y: number; t: number }[] = [];
const availableListeners = new Set<() => void>();

const near = (s: NativeStroke, x: number, y: number) => Math.abs(s.pts[0] - x) < MATCH && Math.abs(s.pts[1] - y) < MATCH;
const markActive = () => (activeUntil = performance.now() + ACTIVE_MS);

if (bridge) {
  bridge.onStroke((stroke) => {
    const t = performance.now();
    markActive();
    const w = waiting.findIndex((x) => near(stroke, x.x, x.y));
    if (w >= 0) {
      waiting.splice(w, 1)[0].resolve(stroke);
      return;
    }
    // a tap the page rejected after the pen lifted
    if (rejected.some((r) => t - r.t < 1000 && Math.abs(r.x - stroke.pts[0]) < MATCH && Math.abs(r.y - stroke.pts[1]) < MATCH)) return;
    arrived.push({ stroke, t });
    while (arrived.length && t - arrived[0].t > 1000) arrived.shift();
  });
  void bridge.available().then((v) => {
    available = v;
    availableListeners.forEach((cb) => cb());
  });
}

export const nativeInk = {
  get available() {
    return available;
  },

  onAvailable(cb: () => void): () => void {
    availableListeners.add(cb);
    return () => availableListeners.delete(cb);
  },

  configure(cfg: NativeInkConfig) {
    if (!bridge || !available) return;
    config = cfg;
    const s = JSON.stringify(cfg);
    if (s === sent) return;
    sent = s;
    bridge.configure(cfg);
  },

  disable() {
    if (config?.enabled) this.configure({ ...config, enabled: false });
  },

  /** Whether the layer draws a pen contact at client point (x, y). */
  drawsAt(x: number, y: number): boolean {
    const c = config;
    if (!c?.enabled) return false;
    const inside = ([l, t, r, b]: number[]) => x >= l && x < r && y >= t && y < b;
    return inside(c.rect) && !c.exclude.some(inside);
  },

  started() {
    markActive();
  },

  /** The stroke that started at client point (x, y), once the layer sends it; null if it does not come. */
  take(x: number, y: number): Promise<NativeStroke | null> {
    const i = arrived.findIndex((a) => near(a.stroke, x, y));
    if (i >= 0) return Promise.resolve(arrived.splice(i, 1)[0].stroke);
    return new Promise((resolve) => {
      const w = {
        x,
        y,
        resolve(s: NativeStroke) {
          clearTimeout(timer);
          resolve(s);
        },
      };
      const timer = setTimeout(() => {
        const k = waiting.indexOf(w);
        if (k >= 0) waiting.splice(k, 1);
        resolve(null);
      }, WAIT_MS);
      waiting.push(w);
    });
  },

  /** The pen contact that started at client point (x, y) is no stroke. */
  reject(x: number, y: number) {
    if (!bridge) return;
    const t = performance.now();
    rejected.push({ x, y, t });
    while (rejected.length && t - rejected[0].t > 1000) rejected.shift();
    for (let i = arrived.length - 1; i >= 0; i--) if (near(arrived[i].stroke, x, y)) arrived.splice(i, 1);
    bridge.reject(x, y);
  },

  /** The page shows the stroke now. */
  shown(seq: number) {
    markActive();
    bridge?.shown(seq);
  },

  /** Clears the layer if it may still show strokes (the page is about to move under it). */
  clearIfShowing() {
    if (performance.now() > activeUntil) return;
    activeUntil = 0;
    bridge?.clear();
  },
};
