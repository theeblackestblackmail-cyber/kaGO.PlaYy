export interface NativeFolderFileEntry {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
  folderPath: string;
}

export interface NativeFolderPickResult {
  ok: boolean;
  cancelled: boolean;
  rootFolder: string;
  files: NativeFolderFileEntry[];
  error?: string;
}

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
  pickFolderNative?: (requestId: string) => void;
  readDocumentChunkBase64?: (uriString: string, offset: number, length: number) => string;
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

export function hasNativeFolderPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.KaGoNative?.pickFolderNative === 'function' &&
    typeof window.KaGoNative?.readDocumentChunkBase64 === 'function'
  );
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  if (!base64) return new Uint8Array(0);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function decodeBase64Utf8(base64: string): string {
  const bytes = decodeBase64ToBytes(base64);
  if (bytes.length === 0) return '';
  try {
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

export function pickNativeFolder(timeoutMs = 180000): Promise<NativeFolderPickResult | null> {
  if (!hasNativeFolderPicker()) {
    return Promise.resolve(null);
  }

  const requestId = `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('kago-native-folder', onFolderEvent);
      window.clearTimeout(timer);
    };

    const onFolderEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<NativeFolderPickResult & { requestId?: string }>)?.detail;
      if (!detail || detail.requestId !== requestId || settled) return;
      settled = true;
      cleanup();
      resolve({
        ok: Boolean(detail.ok),
        cancelled: Boolean(detail.cancelled),
        rootFolder: detail.rootFolder || 'Picked Folder',
        files: Array.isArray(detail.files) ? detail.files : [],
        error: detail.error || undefined,
      });
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('kago-native-folder', onFolderEvent);
      resolve({
        ok: false,
        cancelled: false,
        rootFolder: '',
        files: [],
        error: 'Folder scan timed out.',
      });
    }, timeoutMs);

    window.addEventListener('kago-native-folder', onFolderEvent);
    try {
      window.KaGoNative?.pickFolderNative?.(requestId);
    } catch {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(null);
      }
    }
  });
}

export function readNativeDocumentBytes(uri: string, expectedSize = 0): Uint8Array | null {
  const reader = typeof window !== 'undefined' ? window.KaGoNative?.readDocumentChunkBase64 : undefined;
  if (typeof reader !== 'function') return null;

  const MAX_IMPORT_BYTES = 35 * 1024 * 1024;
  const CHUNK_SIZE = 512 * 1024;
  const limit = expectedSize > 0 ? Math.min(expectedSize, MAX_IMPORT_BYTES) : MAX_IMPORT_BYTES;

  const chunks: Uint8Array[] = [];
  let total = 0;
  let offset = 0;

  while (offset < limit) {
    const reqLen = Math.min(CHUNK_SIZE, limit - offset);
    const b64 = reader(uri, offset, reqLen);
    if (!b64) break;
    const part = decodeBase64ToBytes(b64);
    if (part.length === 0) break;
    chunks.push(part);
    total += part.length;
    offset += part.length;
    if (part.length < reqLen) break;
  }

  if (total === 0) return null;
  const combined = new Uint8Array(total);
  let pos = 0;
  for (const part of chunks) {
    combined.set(part, pos);
    pos += part.length;
  }
  return combined;
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

export function subscribeNativeKeepalive(
  handler: (phase: string) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (ev: Event) => {
    const custom = ev as CustomEvent<{ phase?: string }>;
    handler(custom?.detail?.phase || 'native');
  };
  window.addEventListener('kago-native-keepalive', listener);
  return () => window.removeEventListener('kago-native-keepalive', listener);
}

