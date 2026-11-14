export interface NativeMediaBridgeApi {
  updateNowPlaying: (
    title: string,
    artist: string,
    album: string,
    durationMs: number,
    positionMs: number,
    isPlaying: boolean,
    artworkUrl: string
  ) => void;
  stopBackgroundService: () => void;
  enterPipMode: () => void;
  setVideoModeActive: (active: boolean) => void;
  requestNotificationPermission: () => void;
  fetchUrlAsync?: (requestId: string, urlString: string) => void;
}

export type NativeMediaActionDetail =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'toggle' }
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'seek'; positionMs: number };

declare global {
  interface Window {
    KaGoNative?: NativeMediaBridgeApi;
  }
}

export function isNativeAndroidApp(): boolean {
  return typeof window !== 'undefined' && Boolean(window.KaGoNative);
}

export function hasNativeHttpBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.KaGoNative?.fetchUrlAsync === 'function';
}

function decodeBase64Utf8(base64: string): string {
  if (!base64) return '';
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

export function nativeFetchText(
  url: string,
  timeoutMs = 9500
): Promise<{ ok: boolean; status: number; text: string } | null> {
  if (typeof window === 'undefined' || typeof window.KaGoNative?.fetchUrlAsync !== 'function') {
    return Promise.resolve(null);
  }

  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('kago-native-http', onHttpEvent);
      window.clearTimeout(timer);
    };

    const onHttpEvent = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          requestId?: string;
          ok?: boolean;
          status?: number;
          bodyBase64?: string;
        }>
      )?.detail;
      if (!detail || detail.requestId !== requestId || settled) return;
      settled = true;
      cleanup();
      resolve({
        ok: Boolean(detail.ok),
        status: detail.status ?? 0,
        text: decodeBase64Utf8(detail.bodyBase64 || ''),
      });
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('kago-native-http', onHttpEvent);
      resolve(null);
    }, timeoutMs);

    window.addEventListener('kago-native-http', onHttpEvent);
    try {
      window.KaGoNative?.fetchUrlAsync?.(requestId, url);
    } catch {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(null);
      }
    }
  });
}

export function syncNativeNowPlaying(params: {
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  currentTimeSeconds: number;
  isPlaying: boolean;
  artworkUrl?: string;
}): void {
  if (typeof window === 'undefined' || !window.KaGoNative) return;
  try {
    window.KaGoNative.updateNowPlaying(
      params.title || 'kaGO.PIaY',
      params.artist || 'Unknown Artist',
      params.album || 'kaGO.PIaY Workstation',
      Math.max(0, Math.round((params.durationSeconds || 0) * 1000)),
      Math.max(0, Math.round((params.currentTimeSeconds || 0) * 1000)),
      Boolean(params.isPlaying),
      params.artworkUrl && params.artworkUrl.startsWith('http') ? params.artworkUrl : ''
    );
  } catch {
    // Ignore bridge errors in browser environments
  }
}

export function requestNativeNotificationPermission(): void {
  if (typeof window === 'undefined' || !window.KaGoNative) return;
  try {
    window.KaGoNative.requestNotificationPermission();
  } catch {
    // Ignore
  }
}

export function setNativeVideoMode(active: boolean): void {
  if (typeof window === 'undefined' || !window.KaGoNative) return;
  try {
    window.KaGoNative.setVideoModeActive(active);
  } catch {
    // Ignore
  }
}

export function enterNativeAndroidPip(): boolean {
  if (typeof window === 'undefined' || !window.KaGoNative) return false;
  try {
    window.KaGoNative.enterPipMode();
    return true;
  } catch {
    return false;
  }
}

export function stopNativeMediaService(): void {
  if (typeof window === 'undefined' || !window.KaGoNative) return;
  try {
    window.KaGoNative.stopBackgroundService();
  } catch {
    // Ignore
  }
}

export function subscribeNativeMediaActions(
  handler: (detail: NativeMediaActionDetail) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (ev: Event) => {
    const custom = ev as CustomEvent<NativeMediaActionDetail>;
    if (custom?.detail) {
      handler(custom.detail);
    }
  };
  window.addEventListener('kago-native-media', listener);
  return () => window.removeEventListener('kago-native-media', listener);
}

export function subscribeNativePipState(
  handler: (active: boolean) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (ev: Event) => {
    const custom = ev as CustomEvent<{ active?: boolean }>;
    handler(Boolean(custom?.detail?.active));
  };
  window.addEventListener('kago-native-pip', listener);
  return () => window.removeEventListener('kago-native-pip', listener);
}
