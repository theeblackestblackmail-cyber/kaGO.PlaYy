import type { Track } from '../types/audio';

export const POOR_CONNECTION_THRESHOLD_MS = 30_000;

/**
 * Fisher-Yates shuffle keeping the currently playing track pinned at index 0
 * while capturing the exact pre-shuffle ID sequence so toggling shuffle off
 * restores the original arrangement.
 */
export function shuffleQueuePreservingCurrent(
  queue: Track[],
  currentTrackId?: string | null,
  rng: () => number = Math.random
): { shuffledQueue: Track[]; originalOrderIds: string[] } {
  const originalOrderIds = queue.map((t) => t.id);
  if (queue.length <= 1) {
    return { shuffledQueue: [...queue], originalOrderIds };
  }

  const currentIdx = currentTrackId
    ? queue.findIndex((t) => t.id === currentTrackId)
    : -1;
  const current = currentIdx >= 0 ? queue[currentIdx] : null;
  const pool = currentIdx >= 0 ? queue.filter((_, idx) => idx !== currentIdx) : [...queue];

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return {
    shuffledQueue: current ? [current, ...pool] : pool,
    originalOrderIds,
  };
}

/**
 * Restores a queue back to its saved pre-shuffle ID order while preserving any tracks
 * added after shuffle was turned on and omitting any tracks that were removed.
 */
export function restoreQueueOrder(
  currentQueue: Track[],
  originalOrderIds: string[] | null
): Track[] {
  if (!originalOrderIds || originalOrderIds.length === 0) {
    return currentQueue;
  }

  const byId = new Map<string, Track>();
  for (const track of currentQueue) {
    if (!byId.has(track.id)) {
      byId.set(track.id, track);
    }
  }

  const restored: Track[] = [];
  const placedIds = new Set<string>();

  for (const id of originalOrderIds) {
    const match = byId.get(id);
    if (match && !placedIds.has(id)) {
      restored.push(match);
      placedIds.add(id);
    }
  }

  // Append any tracks added while shuffle was active in their relative order
  for (const track of currentQueue) {
    if (!placedIds.has(track.id)) {
      restored.push(track);
      placedIds.add(track.id);
    }
  }

  return restored;
}

/**
 * Reorders one or multiple selected indices as a cohesive block to `targetIndex`.
 * Handles upward and downward drops intuitively regardless of whether selected rows
 * are contiguous or non-contiguous.
 */
export function reorderMultipleQueueItems<T>(
  items: T[],
  selectedIndices: number[],
  targetIndex: number,
  draggedAnchorIndex?: number
): T[] {
  if (items.length <= 1 || targetIndex < 0 || targetIndex >= items.length) {
    return items;
  }

  const validSorted = Array.from(
    new Set(selectedIndices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < items.length))
  ).sort((a, b) => a - b);

  if (validSorted.length === 0) {
    return items;
  }

  const selectedSet = new Set(validSorted);
  if (selectedSet.has(targetIndex)) {
    return items;
  }

  const anchor =
    typeof draggedAnchorIndex === 'number' && selectedSet.has(draggedAnchorIndex)
      ? draggedAnchorIndex
      : validSorted[0];
  const movingDown = targetIndex > anchor;

  const selectedItems = validSorted.map((idx) => items[idx]);
  const remaining: Array<{ item: T; originalIndex: number }> = [];
  for (let i = 0; i < items.length; i++) {
    if (!selectedSet.has(i)) {
      remaining.push({ item: items[i], originalIndex: i });
    }
  }

  const targetRemainingIdx = remaining.findIndex((entry) => entry.originalIndex === targetIndex);
  if (targetRemainingIdx < 0) {
    return items;
  }

  const insertAt = movingDown ? targetRemainingIdx + 1 : targetRemainingIdx;
  const result = remaining.map((entry) => entry.item);
  result.splice(insertAt, 0, ...selectedItems);
  return result;
}

/**
 * Selects library tracks prioritized by lowest play count (least frequently played first),
 * shuffling ties so Smart Shuffle feels varied while digging up underplayed library songs.
 */
export function selectSmartLibraryTracks(
  libraryTracks: Track[],
  playCounts: Record<string, number>,
  excludeIds: Set<string> = new Set(),
  maxCount = 8,
  rng: () => number = Math.random
): Track[] {
  const userTracks = libraryTracks.filter(
    (t) => t.source !== 'synth' && !excludeIds.has(t.id)
  );
  const synthFallback = libraryTracks.filter(
    (t) => t.source === 'synth' && !excludeIds.has(t.id)
  );
  const pool = userTracks.length > 0 ? userTracks : synthFallback;
  if (pool.length === 0 || maxCount <= 0) return [];

  // Bucket by play count so equal-count tracks get fresh random ordering while strictly
  // preferring lower play counts overall.
  const withJitter = pool.map((track) => ({
    track,
    plays: Math.max(0, playCounts[track.id] || 0),
    jitter: rng(),
  }));

  withJitter.sort((a, b) => {
    if (a.plays !== b.plays) return a.plays - b.plays;
    return a.jitter - b.jitter;
  });

  return withJitter.slice(0, maxCount).map((entry) => ({
    ...entry.track,
    autoQueued: true,
  }));
}

export interface PoorConnectionCheckInput {
  isStreamingTrack: boolean;
  isPlaying: boolean;
  isOnline: boolean;
  isBuffering: boolean;
  lastProgressAtMs: number;
  badSinceMs: number | null;
  nowMs: number;
  dismissedSinceMs: number | null;
  thresholdMs?: number;
}

export interface PoorConnectionCheckResult {
  nextBadSinceMs: number | null;
  elapsedBadMs: number;
  shouldPromptOffline: boolean;
}

/**
 * Evaluates whether an active streaming session has experienced poor/stalled connectivity
 * continuously for at least `thresholdMs` (default 30 seconds).
 */
export function evaluatePoorConnectionState(
  input: PoorConnectionCheckInput
): PoorConnectionCheckResult {
  const threshold = input.thresholdMs ?? POOR_CONNECTION_THRESHOLD_MS;

  if (!input.isStreamingTrack) {
    return {
      nextBadSinceMs: null,
      elapsedBadMs: 0,
      shouldPromptOffline: false,
    };
  }

  const streamTimedOutStall =
    input.isPlaying &&
    input.lastProgressAtMs > 0 &&
    input.nowMs - input.lastProgressAtMs >= 5000;

  const isBadNow = !input.isOnline || (input.isPlaying && (input.isBuffering || streamTimedOutStall));

  if (!isBadNow) {
    return {
      nextBadSinceMs: null,
      elapsedBadMs: 0,
      shouldPromptOffline: false,
    };
  }

  const badSince = input.badSinceMs ?? input.nowMs;
  const elapsedBadMs = Math.max(0, input.nowMs - badSince);
  const alreadyDismissedForThisOutage =
    input.dismissedSinceMs !== null && input.dismissedSinceMs >= badSince;

  return {
    nextBadSinceMs: badSince,
    elapsedBadMs,
    shouldPromptOffline: elapsedBadMs >= threshold && !alreadyDismissedForThisOutage,
  };
}
