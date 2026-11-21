import type { Track } from '../types/audio';
import {
  hasNativeHttpBridge,
  hasNativeHttpPostBridge,
  nativeFetchText,
  nativePostJson,
} from './nativeMediaBridge';
import {
  buildInnertubeBrowseBody,
  extractYouTubePlaylistInfo,
  parseYouTubePlaylistInput,
} from './streamFilter';

export interface YouTubePlaylistImportResult {
  ok: boolean;
  listId?: string;
  title?: string;
  tracks: Track[];
  error?: string;
}

export async function fetchYouTubePlaylistByUrlOrId(
  rawInput: string,
  preferredTitle?: string
): Promise<YouTubePlaylistImportResult> {
  const listId = parseYouTubePlaylistInput(rawInput);
  if (!listId) {
    return {
      ok: false,
      tracks: [],
      error: 'Paste a valid YouTube playlist link (containing ?list=...) or playlist ID.',
    };
  }

  const fallbackTitle = preferredTitle?.trim() || 'YouTube Playlist';

  // 1. Server endpoint (Web / PWA)
  try {
    const res = await fetch(
      `/api/stream/playlist?list=${encodeURIComponent(listId)}&title=${encodeURIComponent(
        fallbackTitle
      )}`
    );
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = (await res.json()) as { title?: string; tracks?: Track[] };
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      if (tracks.length > 0) {
        return {
          ok: true,
          listId,
          title: preferredTitle?.trim() || data.title || fallbackTitle,
          tracks,
        };
      }
    }
  } catch {
    // Fall through to native Android HTTP bridge
  }

  // 2. Native Android APK bridge (Innertube browse + playlist HTML)
  if (hasNativeHttpPostBridge()) {
    const browseRes = await nativePostJson(
      'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false',
      buildInnertubeBrowseBody(listId.startsWith('VL') ? listId : `VL${listId}`),
      9500
    );
    if (browseRes?.ok && browseRes.text) {
      const info = extractYouTubePlaylistInfo(browseRes.text, fallbackTitle);
      if (info.tracks.length > 0) {
        return {
          ok: true,
          listId,
          title: preferredTitle?.trim() || info.title,
          tracks: info.tracks,
        };
      }
    }
  }

  if (hasNativeHttpBridge()) {
    const htmlRes = await nativeFetchText(
      `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
      9500
    );
    if (htmlRes?.ok && htmlRes.text) {
      const info = extractYouTubePlaylistInfo(htmlRes.text, fallbackTitle);
      if (info.tracks.length > 0) {
        return {
          ok: true,
          listId,
          title: preferredTitle?.trim() || info.title,
          tracks: info.tracks,
        };
      }
    }
  }

  return {
    ok: false,
    listId,
    tracks: [],
    error: 'No playable songs found. Make sure the YouTube playlist is set to Unlisted or Public.',
  };
}
