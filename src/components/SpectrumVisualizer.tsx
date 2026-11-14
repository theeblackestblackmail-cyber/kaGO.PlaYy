import React, { useEffect, useRef } from 'react';
import { audioEngine } from '../audio/AudioEngine';
import type { DspSettings } from '../types/audio';

interface SpectrumVisualizerProps {
  isPlaying: boolean;
  dsp: DspSettings;
  height?: number;
  compact?: boolean;
}

export const SpectrumVisualizer: React.FC<SpectrumVisualizerProps> = ({
  isPlaying,
  dsp,
  height,
  compact = false,
}) => {
  const resolvedHeight = typeof height === 'number' ? height : compact ? 104 : 148;
  const isMini = resolvedHeight <= 68;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaksRef = useRef<number[]>(new Array(44).fill(0));
  const barsRef = useRef<number[]>(new Array(44).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    const freqBuffer = new Uint8Array(64);
    const barCount = 44;

    const renderFrame = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(240, Math.floor(rect.width));
      const h = resolvedHeight;

      if (canvas.width !== width * dpr || canvas.height !== h * dpr) {
        canvas.width = width * dpr;
        canvas.height = h * dpr;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);

      const rootEl = document.documentElement;
      const rootStyle = getComputedStyle(rootEl);
      const accentDark = rootStyle.getPropertyValue('--kago-accent-dark').trim() || '#9F1239';
      const accentBase = rootStyle.getPropertyValue('--kago-accent').trim() || '#E11D48';
      const accentLight = rootStyle.getPropertyValue('--kago-accent-light').trim() || '#FF5A5F';
      const accentSoft = rootStyle.getPropertyValue('--kago-accent-soft').trim() || '#FDA4AF';
      const isLightMode = rootEl.classList.contains('light');

      // Subtle reference grid lines
      ctx.strokeStyle = isLightMode ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      for (let g = 1; g <= 3; g++) {
        const gy = Math.round((h / 4) * g) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(width, gy);
        ctx.stroke();
      }

      const hasAnalyser = audioEngine.getFrequencyData(freqBuffer);
      const hasLiveSignal = hasAnalyser && freqBuffer.some((v) => v > 4);
      const nowSec = performance.now() / 1000;
      const gap = 3;
      const barW = Math.max(2, (width - gap * (barCount - 1)) / barCount);

      for (let i = 0; i < barCount; i++) {
        let targetNorm = 0;
        if (isPlaying && hasLiveSignal) {
          const binIdx = Math.min(freqBuffer.length - 1, Math.floor((i / barCount) * 48));
          const rawVal = freqBuffer[binIdx] / 255;
          // Shape subtle floor + responsive peaks
          targetNorm = Math.min(1, rawVal * 1.08);
        } else if (isPlaying) {
          // Cross-origin iframe streams (YouTube) cannot expose raw PCM to AnalyserNode:
          // drive smooth multi-harmonic bars shaped by the active 5-band EQ & 80 Hz Bass Boost
          const bandFloat = (i / (barCount - 1)) * 4;
          const b0 = Math.floor(bandFloat);
          const b1 = Math.min(4, b0 + 1);
          const frac = bandFloat - b0;
          const eqDb =
            (dsp.bands[b0] ?? 0) * (1 - frac) + (dsp.bands[b1] ?? 0) * frac;
          const boostDb = i < 9 && dsp.bassBoostEnabled ? dsp.bassBoostDb * 0.45 : 0;
          const eqScale = Math.max(0.45, Math.min(1.45, 1 + (eqDb + boostDb) / 24));
          const bassRollOff = 0.88 - (i / barCount) * 0.36;
          const beatPulse =
            0.34 +
            0.26 * Math.sin(nowSec * 6.4 - i * 0.28) +
            0.16 * Math.cos(nowSec * 11.2 + i * 0.71) +
            0.12 * Math.sin(nowSec * 3.1 + i * 0.15);
          targetNorm = Math.max(0.08, Math.min(0.96, beatPulse * bassRollOff * eqScale));
        } else {
          targetNorm = 0.03;
        }

        // Smooth interpolation
        const prev = barsRef.current[i] || 0;
        const nextVal = targetNorm > prev ? prev + (targetNorm - prev) * 0.45 : prev * 0.86;
        barsRef.current[i] = Math.max(0.025, nextVal);

        // Falling peak cap physics
        if (barsRef.current[i] >= peaksRef.current[i]) {
          peaksRef.current[i] = barsRef.current[i];
        } else {
          peaksRef.current[i] = Math.max(0.035, peaksRef.current[i] - 0.0085);
        }

        const barH = Math.max(2, barsRef.current[i] * Math.max(16, h - 10));
        const x = i * (barW + gap);
        const y = h - barH;

        const grad = ctx.createLinearGradient(x, h, x, y);
        grad.addColorStop(0, accentDark);
        grad.addColorStop(0.55, accentBase);
        grad.addColorStop(1, accentLight);

        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, barH);

        // Falling peak cap
        const peakY = Math.max(1, h - peaksRef.current[i] * Math.max(16, h - 10) - 3);
        ctx.fillStyle = isPlaying ? accentSoft : isLightMode ? '#94A3B8' : '#3E4251';
        ctx.fillRect(x, peakY, barW, 2);
      }

      const stillSettling =
        isPlaying ||
        barsRef.current.some((v) => v > 0.03) ||
        peaksRef.current.some((p) => p > 0.04);

      if (stillSettling) {
        rafId = requestAnimationFrame(renderFrame);
      }
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, resolvedHeight, dsp]);

  return (
    <div
      className={`rounded-lg border border-[#1B1D26] bg-[#050508] ${
        isMini ? 'px-3 py-2' : 'p-3.5'
      }`}
    >
      <div
        className={`flex flex-wrap items-center justify-between gap-2 text-[11px] sm:text-xs text-[#8E929B] ${
          isMini ? 'mb-1.5' : 'mb-2'
        }`}
      >
        <span className="font-mono-tabular">20 Hz – 20 kHz Spectrum</span>
        <div className="flex items-center gap-3 font-mono-tabular">
          <span>EQ: {dsp.preset}</span>
          <span aria-hidden="true">·</span>
          <span className={dsp.bassBoostEnabled ? 'text-[#FF4D6D]' : ''}>
            80 Hz Boost: {dsp.bassBoostEnabled ? `+${dsp.bassBoostDb} dB` : 'Bypass'}
          </span>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="spectrum-canvas"
        className="w-full block"
        style={{ height: `${resolvedHeight}px` }}
      />
    </div>
  );
};
