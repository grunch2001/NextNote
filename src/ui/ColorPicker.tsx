import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { hexToHsv, hsvToHex, normalizeHex, type HSV } from '../model/colors';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Pointer handlers for a 2D drag area; reports the position as fractions (0–1) of its size. */
function dragHandlers(onPos: (x: number, y: number) => void) {
  const report = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onPos(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
  };
  return {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      report(e);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) report(e);
    },
  };
}

/** Free colour choice from the whole RGB spectrum: saturation/brightness field, hue strip and hex input. */
export function SpectrumPicker({ color, onChange }: { color: string; onChange(c: string): void }) {
  // HSV is kept locally so the hue survives while saturation or brightness is 0 (grey / black).
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(color));
  const [text, setText] = useState(color.toUpperCase());
  const [synced, setSynced] = useState(color);
  if (color !== synced) {
    setSynced(color);
    if (hsvToHex(hsv) !== normalizeHex(color)) setHsv(hexToHsv(color));
    if (normalizeHex(text) !== normalizeHex(color)) setText(color.toUpperCase());
  }

  const update = (patch: Partial<HSV>) => {
    const next = { ...hsv, ...patch };
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex);
    if (hex !== normalizeHex(color)) onChange(hex);
  };

  const commitText = () => {
    const hex = normalizeHex(text);
    if (hex) {
      setText(hex);
      if (hex !== normalizeHex(color)) onChange(hex);
    } else setText(color.toUpperCase());
  };

  const svKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    update({ s: clamp01(hsv.s + d[0]), v: clamp01(hsv.v + d[1]) });
  };

  const hueKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 30 : 5;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    update({ h: Math.min(360, Math.max(0, hsv.h + d)) });
  };

  const current = hsvToHex(hsv);
  return (
    <div className="spectrum">
      <div
        className="spectrum-sv"
        style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        {...dragHandlers((x, y) => update({ s: x, v: 1 - y }))}
        onKeyDown={svKeys}
        tabIndex={0}
        role="slider"
        aria-label="Sättigung und Helligkeit"
        aria-valuetext={`Sättigung ${Math.round(hsv.s * 100)} %, Helligkeit ${Math.round(hsv.v * 100)} %`}
      >
        <span className="spectrum-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }} />
      </div>
      <div
        className="spectrum-hue"
        {...dragHandlers((x) => update({ h: x * 360 }))}
        onKeyDown={hueKeys}
        tabIndex={0}
        role="slider"
        aria-label="Farbton"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
      >
        <span className="spectrum-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
      </div>
      <div className="spectrum-row">
        <span className="spectrum-preview" style={{ background: current }} />
        <input
          className="spectrum-hex"
          value={text}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-label="Farbcode (Hex)"
          onChange={(e) => {
            setText(e.target.value);
            // apply while typing only once all six digits are there; "#abc" is accepted on Enter/blur
            const hex = /^#?[0-9a-f]{6}$/i.test(e.target.value.trim()) ? normalizeHex(e.target.value) : null;
            if (hex && hex !== normalizeHex(color)) onChange(hex);
          }}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitText();
              e.currentTarget.blur();
            }
          }}
        />
      </div>
    </div>
  );
}
