import { isNativeAndroidApp, triggerNativeHaptic } from './nativeMediaBridge';

export type HapticStyle = 'light' | 'selection' | 'medium' | 'reorder' | 'success';

export const HAPTIC_PATTERNS: Record<HapticStyle, number | number[]> = {
  light: 10,
  selection: 14,
  medium: 20,
  reorder: 24,
  success: [12, 26, 18],
};

export function resolveHapticPattern(style: HapticStyle): number | number[] {
  return HAPTIC_PATTERNS[style] ?? HAPTIC_PATTERNS.light;
}

export function shouldThrottleHaptic(
  nowMs: number,
  lastTriggeredMs: number,
  minGapMs = 28
): boolean {
  if (lastTriggeredMs <= 0) return false;
  return nowMs - lastTriggeredMs < minGapMs;
}

let lastHapticAt = 0;

export function triggerHaptic(style: HapticStyle = 'light', minGapMs = 28): boolean {
  if (typeof window === 'undefined') return false;
  const now = Date.now();
  if (shouldThrottleHaptic(now, lastHapticAt, minGapMs)) {
    return false;
  }
  lastHapticAt = now;

  if (isNativeAndroidApp() && triggerNativeHaptic(style)) {
    return true;
  }

  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      return Boolean(navigator.vibrate(resolveHapticPattern(style)));
    } catch {
      return false;
    }
  }

  return false;
}
