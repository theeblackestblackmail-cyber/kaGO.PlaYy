import type { Track } from '../types/audio';
import { readAudioFileTags } from './audioMetadata';
import {
  pickNativeFolder,
  readNativeDocumentBytes,
  type NativeFolderFileEntry,
} from './nativeMediaBridge';

export const AUDIO_FILE_RE = /\.(mp3|flac|wav|ogg|oga|m4a|m4b|aac|opus|webm|wma|aiff|amr|3gp|mp2)$/i;

export interface FolderScanProgress {
  scanned: number;
  found: number;
  currentFile: string;
}

export function isSupportedAudioFile(file: Pick<File, 'name' | 'type'>): boolean {
  return AUDIO_FILE_RE.test(file.name) || (file.type ? file.type.startsWith('audio/') : false);
}

export function createFileFromNativeEntry(entry: NativeFolderFileEntry): File | null {
  try {
    const bytes = readNativeDocumentBytes(entry.uri, entry.size);
    if (!bytes || bytes.length === 0) return null;
    const blobPart = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    return new File([blobPart], entry.name || 'audio-track.mp3', {
      type: entry.mimeType || 'audio/mpeg',
      lastModified: entry.lastModified || Date.now(),
    });
  } catch {
    return null;
  }
}

export function resolveFolderPathFromRelativePath(
  relativePath?: string,
  fallback = 'Picked Folder'
): string {
  if (!relativePath) return fallback;
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length <= 1) return fallback;
  return segments.slice(0, -1).join('/');
}

const GENERIC_FOLDER_LABELS = new Set([
  'Picked Songs',
  'Picked Folder',
  'Local Import',
  'Imported Files',
]);

export function mergeImportedTracks(
  existingTracks: Track[],
  incomingTracks: Track[]
): Track[] {
  if (incomingTracks.length === 0) return existingTracks;

  const incomingById = new Map<string, Track>();
  for (const t of incomingTracks) {
    incomingById.set(t.id, t);
  }

  const seenIds = new Set<string>();
  const updatedExisting = existingTracks.map((prev) => {
    seenIds.add(prev.id);
    const next = incomingById.get(prev.id);
    if (!next) return prev;
    const nextFolder = next.folderPath?.trim() || '';
    const prevFolder = prev.folderPath?.trim() || '';
    const shouldAdoptIncomingFolder =
      nextFolder.length > 0 &&
      (!prevFolder ||
        GENERIC_FOLDER_LABELS.has(prevFolder) ||
        !GENERIC_FOLDER_LABELS.has(nextFolder));
    return {
      ...prev,
      ...next,
      folderPath: shouldAdoptIncomingFolder ? nextFolder : prevFolder || 'Picked Folder',
    };
  });

  const brandNew = incomingTracks.filter((t) => !seenIds.has(t.id));
  return [...brandNew, ...updatedExisting];
}

export async function buildTracksFromFilePairs(
  filePairs: Array<{ file: File; folderPath: string }>,
  onProgress?: (progress: FolderScanProgress) => void
): Promise<Array<{ track: Track; file: File }>> {
  const audioPairs = filePairs.filter(({ file }) => isSupportedAudioFile(file));
  const importedEntries: Array<{ track: Track; file: File }> = [];

  for (let i = 0; i < audioPairs.length; i++) {
    const { file, folderPath } = audioPairs[i];
    onProgress?.({
      scanned: i + 1,
      found: audioPairs.length,
      currentFile: file.name,
    });

    const folderLabel = folderPath.split('/').filter(Boolean).pop() || 'Local Import';
    const meta = await readAudioFileTags(file, folderLabel);

    const track: Track = {
      id: `local-${file.name}-${file.size}-${file.lastModified}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      trackNumber: meta.trackNumber,
      duration: 180,
      source: 'local',
      folderPath: folderPath || 'Picked Folder',
      addedAt: Date.now(),
    };

    importedEntries.push({ track, file });
  }

  return importedEntries;
}

export interface NativeFolderImportOptions {
  onProgress?: (progress: FolderScanProgress) => void;
  onTrackReady?: (entry: { track: Track; file: File }) => Promise<void> | void;
}

export async function importFromNativeFolderPicker(
  onProgressOrOptions?: ((progress: FolderScanProgress) => void) | NativeFolderImportOptions
): Promise<{
  cancelled: boolean;
  error?: string;
  failedFiles: number;
  entries: Array<{ track: Track; file: File }>;
  tracks: Track[];
}> {
  const opts: NativeFolderImportOptions =
    typeof onProgressOrOptions === 'function'
      ? { onProgress: onProgressOrOptions }
      : onProgressOrOptions || {};

  const res = await pickNativeFolder();
  if (!res) {
    return {
      cancelled: false,
      error: 'Native folder picker not available.',
      failedFiles: 0,
      entries: [],
      tracks: [],
    };
  }
  if (res.cancelled) {
    return { cancelled: true, failedFiles: 0, entries: [], tracks: [] };
  }
  if (!res.ok) {
    return {
      cancelled: false,
      error: res.error || 'Could not read selected folder.',
      failedFiles: 0,
      entries: [],
      tracks: [],
    };
  }

  const total = res.files.length;
  const importedEntries: Array<{ track: Track; file: File }> = [];
  const importedTracks: Track[] = [];
  let failedFiles = 0;

  for (let i = 0; i < total; i++) {
    const entry = res.files[i];
    if (!entry || !entry.uri || !entry.name) {
      failedFiles++;
      continue;
    }

    opts.onProgress?.({
      scanned: i + 1,
      found: total,
      currentFile: entry.name,
    });

    // Yield a frame so Android WebView UI stays responsive on large folders
    await new Promise<void>((r) => setTimeout(r, 0));

    try {
      const file = createFileFromNativeEntry(entry);
      if (!file) {
        failedFiles++;
        continue;
      }

      const safeFolderPath = (entry.folderPath || res.rootFolder || 'Picked Folder').trim();
      const folderLabel = safeFolderPath.split('/').filter(Boolean).pop() || res.rootFolder || 'Picked Folder';
      const meta = await readAudioFileTags(file, folderLabel);

      const track: Track = {
        id: `local-${file.name}-${file.size}-${file.lastModified}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        trackNumber: meta.trackNumber,
        duration: 180,
        source: 'local',
        folderPath: safeFolderPath,
        addedAt: Date.now(),
      };

      importedTracks.push(track);
      if (opts.onTrackReady) {
        await opts.onTrackReady({ track, file });
      } else {
        importedEntries.push({ track, file });
      }
    } catch {
      failedFiles++;
    }
  }

  if (total > 0 && importedTracks.length === 0) {
    return {
      cancelled: false,
      error: `Found ${total} ${total === 1 ? 'song' : 'songs'} in "${res.rootFolder || 'folder'}", but Android could not read their bytes. Try moving the files or re-picking the folder.`,
      failedFiles,
      entries: [],
      tracks: [],
    };
  }

  return {
    cancelled: false,
    failedFiles,
    entries: importedEntries,
    tracks: importedTracks,
  };
}
