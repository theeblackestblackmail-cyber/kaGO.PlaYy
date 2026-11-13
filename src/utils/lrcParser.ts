import type { LyricLine } from '../types/audio';

const TIMESTAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(rawLrc: string): LyricLine[] {
  if (!rawLrc || !rawLrc.trim()) return [];

  const parsed: LyricLine[] = [];
  const rawLines = rawLrc.split(/\r?\n/);

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const matches = [...trimmed.matchAll(TIMESTAMP_RE)];
    if (matches.length === 0) {
      // Skip metadata tags like [ar:Artist] or [ti:Title]
      if (/^\[[a-z]{2,6}:.*\]$/i.test(trimmed)) continue;
      continue;
    }

    const text = trimmed.replace(TIMESTAMP_RE, '').trim();
    if (!text) continue;

    for (const match of matches) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const fracRaw = match[3] || '0';
      const frac =
        fracRaw.length === 3
          ? parseInt(fracRaw, 10) / 1000
          : fracRaw.length === 2
          ? parseInt(fracRaw, 10) / 100
          : parseInt(fracRaw, 10) / 10;

      const time = minutes * 60 + seconds + frac;
      parsed.push({ time: Number(time.toFixed(3)), text });
    }
  }

  return parsed.sort((a, b) => a.time - b.time);
}

export function formatLrcTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const hundredths = Math.floor((safe - Math.floor(safe)) * 100);
  return `[${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

export function findActiveLyricIndex(
  lines: LyricLine[],
  currentTime: number,
  offsetSeconds = 0
): number {
  if (lines.length === 0) return -1;
  const adjustedTime = currentTime + offsetSeconds;
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= adjustedTime + 0.05) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
