import type { Track } from '../types/audio';

export const PROACTIVE_PRELOAD_COUNT = 3;
export const PRELOAD_SETTLE_DELAY_MS = 1800;

export interface NetworkStabilityInput {
  isOnline: boolean;
  saveData?: boolean;
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
  isStreamingTrack: boolean;
  isBuffering: boolean;
  streamErrorCount: number;
  nowMs: number;
  trackStartedAtMs: number;
  lastOnlineAtMs: number;
}

export interface NetworkStabilityResult {
  isStable: boolean;
  reason:
    | 'offline'
    | 'save-data'
    | 'slow-network'
    | 'active-buffering'
    | 'stream-errors'
    | 'settling'
    | 'stable-3g'
    | 'stable';
  maxConcurrent: number;
  retryDelayMs: number;
}

/**
 * Evaluates whether the current network connection & playback pipeline are healthy and stable
 * enough to proactively buffer the next 3 tracks without starving active playback or user data.
 */
export function evaluateNetworkStability(
  input: NetworkStabilityInput
): NetworkStabilityResult {
  if (!input.isOnline) {
    return { isStable: false, reason: 'offline', maxConcurrent: 0, retryDelayMs: 5000 };
  }

  if (input.saveData) {
    return { isStable: false, reason: 'save-data', maxConcurrent: 0, retryDelayMs: 15000 };
  }

  const eff = (input.effectiveType || '').toLowerCase();
  if (eff === 'slow-2g' || eff === '2g') {
    return { isStable: false, reason: 'slow-network', maxConcurrent: 0, retryDelayMs: 10000 };
  }

  if (typeof input.rttMs === 'number' && input.rttMs >= 900) {
    return { isStable: false, reason: 'slow-network', maxConcurrent: 0, retryDelayMs: 8000 };
  }

  if (typeof input.downlinkMbps === 'number' && input.downlinkMbps > 0 && input.downlinkMbps < 0.35) {
    return { isStable: false, reason: 'slow-network', maxConcurrent: 0, retryDelayMs: 8000 };
  }

  if (input.isStreamingTrack && input.streamErrorCount > 0) {
    return { isStable: false, reason: 'stream-errors', maxConcurrent: 0, retryDelayMs: 6000 };
  }

  if (input.isStreamingTrack && input.isBuffering) {
    return { isStable: false, reason: 'active-buffering', maxConcurrent: 0, retryDelayMs: 2500 };
  }

  // Give the newly started track or freshly reconnected stream a brief 1.8s bandwidth priority window
  const sinceTrackStart = input.trackStartedAtMs > 0 ? input.nowMs - input.trackStartedAtMs : PRELOAD_SETTLE_DELAY_MS;
  const sinceOnline = input.lastOnlineAtMs > 0 ? input.nowMs - input.lastOnlineAtMs : PRELOAD_SETTLE_DELAY_MS;
  const minElapsed = Math.min(sinceTrackStart, sinceOnline);
  if (minElapsed < PRELOAD_SETTLE_DELAY_MS) {
    return {
      isStable: false,
      reason: 'settling',
      maxConcurrent: 0,
      retryDelayMs: Math.max(250, PRELOAD_SETTLE_DELAY_MS - minElapsed),
    };
  }

  if (eff === '3g') {
    return { isStable: true, reason: 'stable-3g', maxConcurrent: 1, retryDelayMs: 0 };
  }

  return { isStable: true, reason: 'stable', maxConcurrent: 2, retryDelayMs: 0 };
}

/**
 * Selects up to `count` (default 3) unique upcoming tracks immediately following `currentTrackId`
 * in the active queue, wrapping cleanly around the end of the queue when needed.
 */
export function selectUpcomingPreloadTracks(
  queue: Track[],
  currentTrackId?: string | null,
  count = PROACTIVE_PRELOAD_COUNT
): Track[] {
  if (!Array.isArray(queue) || queue.length === 0 || count <= 0) {
    return [];
  }

  const currentIdx = currentTrackId
    ? queue.findIndex((t) => t.id === currentTrackId)
    : -1;

  if (queue.length === 1) {
    // Only 1 track in queue: nothing else upcoming to preload if it's already active
    return currentIdx === 0 ? [] : [queue[0]];
  }

  const startOffset = currentIdx >= 0 ? 1 : 0;
  const baseIdx = currentIdx >= 0 ? currentIdx : 0;
  const seen = new Set<string>(currentTrackId ? [currentTrackId] : []);
  const upcoming: Track[] = [];

  for (let i = startOffset; i < queue.length + startOffset && upcoming.length < count; i++) {
    const candidate = queue[(baseIdx + i) % queue.length];
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    upcoming.push(candidate);
  }

  return upcoming;
}

/**
 * Computes cache diff so the pre-buffer pool holds strictly the active upcoming 3-track window.
 */
export function computePreloadEvictions(
  cachedIds: Iterable<string>,
  targetTracks: Track[]
): { toKeep: Set<string>; toEvict: string[]; toStart: Track[] } {
  const existing = new Set(cachedIds);
  const targetIds = new Set(targetTracks.map((t) => t.id));

  const toKeep = new Set<string>();
  const toEvict: string[] = [];

  for (const id of existing) {
    if (targetIds.has(id)) {
      toKeep.add(id);
    } else {
      toEvict.push(id);
    }
  }

  const toStart = targetTracks.filter((t) => !existing.has(t.id));
  return { toKeep, toEvict, toStart };
}
