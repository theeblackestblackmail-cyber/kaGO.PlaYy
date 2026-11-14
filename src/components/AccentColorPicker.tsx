import React, { useEffect, useRef, useState } from 'react';
import { Pipette, RotateCcw } from 'lucide-react';
import {
  ACCENT_SWATCHES,
  DEFAULT_ACCENT_HEX,
  hexToHsv,
  hsvToHex,
  normalizeHex,
} from '../utils/themeManager';

interface AccentColorPickerProps {
  accentHex: string;
  accentAlpha: number;
  onChange: (nextHex: string, nextAlpha: number) => void;
  onReset: () => void;
}

export const AccentColorPicker: React.FC<AccentColorPickerProps> = ({
  accentHex,
  accentAlpha,
  onChange,
  onReset,
}) => {
  const [hsv, setHsv] = useState(() => hexToHsv(accentHex));
  const [hexDraft, setHexDraft] = useState(() => accentHex.replace(/^#/, ''));

  const svBoxRef = useRef<HTMLDivElement | null>(null);
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const hueBarRef = useRef<HTMLDivElement | null>(null);
  const alphaBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const clean = normalizeHex(accentHex);
    if (!clean) return;
    setHexDraft(clean.replace(/^#/, ''));
    const nextHsv = hexToHsv(clean);
    setHsv((prev) => {
      // Preserve current hue when picking pure black/white/gray so the hue slider doesn't jump to 0
      const keepHue = nextHsv.s === 0 || nextHsv.v === 0;
      return {
        h: keepHue ? prev.h : nextHsv.h,
        s: nextHsv.s,
        v: nextHsv.v,
      };
    });
  }, [accentHex]);

  const pureHueHex = hsvToHex(hsv.h, 100, 100);

  const commitHsv = (nextH: number, nextS: number, nextV: number, nextAlpha = accentAlpha) => {
    const clampedH = ((Math.round(nextH) % 360) + 360) % 360;
    const clampedS = Math.max(0, Math.min(100, Math.round(nextS)));
    const clampedV = Math.max(0, Math.min(100, Math.round(nextV)));
    setHsv({ h: clampedH, s: clampedS, v: clampedV });
    const hex = hsvToHex(clampedH, clampedS, clampedV);
    setHexDraft(hex.replace(/^#/, ''));
    onChange(hex, nextAlpha);
  };

  const attachDrag = (
    el: HTMLDivElement | null,
    handler: (clientX: number, clientY: number, rect: DOMRect) => void,
    startEvent: React.PointerEvent<HTMLDivElement>
  ) => {
    if (!el) return;
    startEvent.preventDefault();
    const target = el;
    try {
      target.setPointerCapture(startEvent.pointerId);
    } catch {
      // Ignore if capture unsupported
    }
    const rect = target.getBoundingClientRect();
    handler(startEvent.clientX, startEvent.clientY, rect);

    const onMove = (ev: PointerEvent) => {
      handler(ev.clientX, ev.clientY, target.getBoundingClientRect());
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const updateSvFromPointer = (clientX: number, clientY: number, rect: DOMRect) => {
    const xPct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const yPct = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    commitHsv(hsv.h, xPct * 100, (1 - yPct) * 100);
  };

  const updateWheelFromPointer = (clientX: number, clientY: number, rect: DOMRect) => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (deg < 0) deg += 360;
    const maxR = Math.max(1, rect.width / 2);
    const dist = Math.min(maxR, Math.hypot(dx, dy));
    // Outer ring picks vivid hue; dragging toward center adjusts saturation
    const sat = dist > maxR * 0.65 ? Math.max(hsv.s, 75) : Math.round((dist / (maxR * 0.65)) * 100);
    commitHsv(deg, Math.max(15, sat), Math.max(hsv.v, 70));
  };

  const updateHueFromPointer = (clientX: number, _clientY: number, rect: DOMRect) => {
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    commitHsv(pct * 360, hsv.s, hsv.v);
  };

  const updateAlphaFromPointer = (clientX: number, _clientY: number, rect: DOMRect) => {
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const nextAlpha = Math.max(25, Math.min(100, Math.round(25 + pct * 75)));
    onChange(accentHex, nextAlpha);
  };

  const handleHexInputChange = (raw: string) => {
    const clean = raw.replace(/[^0-9a-fA-F#]/g, '').slice(0, 7);
    setHexDraft(clean.replace(/^#/, '').toUpperCase());
    const parsed = normalizeHex(clean);
    if (parsed) {
      onChange(parsed, accentAlpha);
    }
  };

  const wheelAngleRad = ((hsv.h - 90) * Math.PI) / 180;
  const wheelIndicatorX = 50 + Math.cos(wheelAngleRad) * 41;
  const wheelIndicatorY = 50 + Math.sin(wheelAngleRad) * 41;
  const huePct = (hsv.h / 360) * 100;
  const alphaPct = ((accentAlpha - 25) / 75) * 100;

  return (
    <div className="rounded-xl border border-[#242732] bg-[#16181F] p-3.5 sm:p-4 space-y-3.5">
      {/* Top Interactive Color Area: Saturation/Brightness Box + Circular Color Wheel */}
      <div className="grid grid-cols-1 min-[440px]:grid-cols-12 gap-3.5 items-center">
        {/* Figma-style 2D Saturation / Brightness Square */}
        <div className="min-[440px]:col-span-7">
          <div
            ref={svBoxRef}
            role="slider"
            tabIndex={0}
            aria-label="Accent color saturation and brightness"
            aria-valuetext={`Saturation ${hsv.s} percent, brightness ${hsv.v} percent`}
            onPointerDown={(e) => attachDrag(svBoxRef.current, updateSvFromPointer, e)}
            style={{
              backgroundColor: pureHueHex,
              touchAction: 'none',
            }}
            className="relative h-44 sm:h-48 w-full overflow-hidden rounded-xl border border-[#2A2D39] cursor-crosshair select-none"
          >
            {/* White -> Transparent horizontal saturation gradient */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: 'linear-gradient(to right, #ffffff, rgba(255,255,255,0))',
              }}
            />
            {/* Transparent -> Black vertical brightness gradient */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: 'linear-gradient(to top, #000000, rgba(0,0,0,0))',
              }}
            />
            {/* Draggable Puck */}
            <div
              className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_6px_rgba(0,0,0,0.85)]"
              style={{
                left: `${hsv.s}%`,
                top: `${100 - hsv.v}%`,
                backgroundColor: accentHex,
              }}
            />
          </div>
        </div>

        {/* Circular Interactive Color Wheel */}
        <div className="min-[440px]:col-span-5 flex flex-col items-center justify-center gap-2">
          <div
            ref={wheelRef}
            role="slider"
            tabIndex={0}
            aria-label="Color wheel hue picker"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={hsv.h}
            onPointerDown={(e) => attachDrag(wheelRef.current, updateWheelFromPointer, e)}
            style={{
              background:
                'conic-gradient(#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
              touchAction: 'none',
            }}
            className="relative h-36 w-36 sm:h-40 sm:w-40 rounded-full border-2 border-[#2A2D39] shadow-[0_8px_24px_rgba(0,0,0,0.55)] cursor-crosshair select-none"
          >
            {/* Inner radial saturation soften */}
            <div
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                background:
                  'radial-gradient(circle, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 68%)',
              }}
            />
            {/* Center Live Swatch Preview */}
            <div className="pointer-events-none absolute inset-0 m-auto flex h-14 w-14 flex-col items-center justify-center rounded-full border-2 border-[#16181F] shadow-lg" style={{ backgroundColor: accentHex }}>
              <span className="font-mono-tabular text-[10px] font-bold text-white drop-shadow">
                {hsv.h}°
              </span>
            </div>
            {/* Wheel Ring Indicator */}
            <div
              className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_5px_rgba(0,0,0,0.9)]"
              style={{
                left: `${wheelIndicatorX}%`,
                top: `${wheelIndicatorY}%`,
                backgroundColor: pureHueHex,
              }}
            />
          </div>
          <span className="font-mono-tabular text-[11px] text-[#8E929B]">
            Drag wheel or square
          </span>
        </div>
      </div>

      {/* Rainbow Hue Bar + Intensity/Opacity Bar (Figma Picker Layout) */}
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#2A2D39]"
          style={{ backgroundColor: accentHex }}
          title={`Selected color ${accentHex}`}
        >
          <Pipette className="h-4 w-4 text-white drop-shadow" />
        </div>

        <div className="flex-1 space-y-2.5">
          {/* Rainbow Hue Slider */}
          <div
            ref={hueBarRef}
            role="slider"
            tabIndex={0}
            aria-label="Color hue slider"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={hsv.h}
            onPointerDown={(e) => attachDrag(hueBarRef.current, updateHueFromPointer, e)}
            style={{
              background:
                'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
              touchAction: 'none',
            }}
            className="relative h-4 w-full rounded-full border border-white/15 cursor-pointer select-none"
          >
            <div
              className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-md"
              style={{
                left: `${huePct}%`,
                backgroundColor: pureHueHex,
              }}
            />
          </div>

          {/* Intensity / Opacity Slider */}
          <div
            ref={alphaBarRef}
            role="slider"
            tabIndex={0}
            aria-label="Accent color intensity"
            aria-valuemin={25}
            aria-valuemax={100}
            aria-valuenow={accentAlpha}
            onPointerDown={(e) => attachDrag(alphaBarRef.current, updateAlphaFromPointer, e)}
            style={{
              backgroundImage: `linear-gradient(to right, transparent, ${accentHex}), repeating-conic-gradient(#2d313d 0% 25%, #1c1f28 0% 50%)`,
              backgroundSize: '100% 100%, 10px 10px',
              touchAction: 'none',
            }}
            className="relative h-4 w-full rounded-full border border-white/15 cursor-pointer select-none"
          >
            <div
              className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-[#D9D9D9] shadow-md"
              style={{
                left: `${alphaPct}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Bottom Hex + Percentage + Reset Row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex h-9 items-center rounded-lg border border-[#2A2D39] bg-[#0D0E12] px-3 text-xs font-semibold text-[#C7C9D1]">
          Hex
        </div>

        <div className="flex h-9 flex-1 min-w-[130px] items-center rounded-lg border border-[#2A2D39] bg-[#0D0E12] overflow-hidden">
          <span className="pl-2.5 font-mono-tabular text-xs text-[#8E929B]">#</span>
          <input
            type="text"
            value={hexDraft}
            onChange={(e) => handleHexInputChange(e.target.value)}
            aria-label="Hex accent color code"
            className="w-full bg-transparent px-1.5 py-1 font-mono-tabular text-xs font-semibold text-[#F4F3F0] focus:outline-none uppercase"
          />
          <span className="border-l border-[#2A2D39] px-2.5 font-mono-tabular text-xs text-[#C7C9D1] whitespace-nowrap">
            {accentAlpha} %
          </span>
        </div>

        <button
          type="button"
          onClick={onReset}
          disabled={accentHex.toUpperCase() === DEFAULT_ACCENT_HEX && accentAlpha === 100}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#2A2D39] bg-[#12141B] px-3 text-xs font-semibold text-[#D1D5DB] hover:border-[#E11D48] hover:text-white disabled:opacity-45 cursor-pointer whitespace-nowrap"
        >
          <RotateCcw className="h-3.5 w-3.5 text-[#E11D48]" />
          <span>Default Red</span>
        </button>
      </div>

      {/* Quick Accent Swatches */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-[11px] font-medium text-[#8E929B]">Quick Colors:</span>
        {ACCENT_SWATCHES.map((swatch) => {
          const isSelected = accentHex.toUpperCase() === swatch.hex.toUpperCase();
          return (
            <button
              key={swatch.hex}
              type="button"
              onClick={() => onChange(swatch.hex, 100)}
              aria-label={`Select ${swatch.name} accent color`}
              title={swatch.name}
              style={{ backgroundColor: swatch.hex }}
              className={`h-7 w-7 rounded-full border-2 transition-transform cursor-pointer ${
                isSelected
                  ? 'scale-110 border-white shadow-[0_0_10px_rgba(255,255,255,0.45)]'
                  : 'border-[#2A2D39] hover:scale-105'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
};
