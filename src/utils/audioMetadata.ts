import type { Track } from '../types/audio';
import { sanitizeFilename } from './filenameSanitizer';

export interface ParsedAudioMetadata {
  title: string;
  artist: string;
  album: string;
  trackNumber?: number;
}

const NON_PRINTABLE_RE = /[\u0000-\u001F\u007F\uFEFF\uFFFE\uFFFD]/g;

export function looksLikeMojibake(text: string | undefined): boolean {
  if (!text) return false;
  if (/[\uE000-\uF8FF\uFFFE\uFFFD\u2000-\u200F\u2800-\u28FF\u3130-\u318F]/.test(text)) {
    return true;
  }

  let swappedAsciiCount = 0;
  let cjkCount = 0;
  let latinCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code & 0xff) === 0 && (code >> 8) >= 0x20 && (code >> 8) <= 0x7e) {
      swappedAsciiCount++;
    }
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjkCount++;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latinCount++;
    }
  }

  if (swappedAsciiCount >= 2) return true;
  if (cjkCount >= 2 && swappedAsciiCount >= 1) return true;
  if (cjkCount >= 3 && latinCount === 0 && /[\u2400-\u27BF\u3000-\u303F]/.test(text)) {
    return true;
  }

  return false;
}

export function repairMojibakeText(raw: string | undefined): string {
  if (!raw) return '';
  let text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF\uFFFE\uFFFD]/g, '').trim();
  if (!text) return '';

  // Check if text came from UTF-16BE bytes decoded as UTF-16LE (e.g. "匀攀攀" = 0x5300 0x6500 0x6500 -> "See")
  let swappedAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const high = code >> 8;
    const low = code & 0xff;
    if (low === 0 && high >= 0x20 && high <= 0x7e) {
      swappedAsciiCount++;
    }
  }

  if (swappedAsciiCount >= 2 && swappedAsciiCount >= text.length * 0.35) {
    const swappedBytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      swappedBytes[i * 2] = code >> 8;
      swappedBytes[i * 2 + 1] = code & 0xff;
    }
    try {
      const recovered = new TextDecoder('utf-16le')
        .decode(swappedBytes)
        .replace(NON_PRINTABLE_RE, '')
        .trim();
      if (recovered && !looksLikeMojibake(recovered)) {
        text = recovered;
      }
    } catch {
      // Ignore decoder error
    }
  }

  return text.replace(NON_PRINTABLE_RE, '').replace(/\s+/g, ' ').trim();
}

function stripSingleBytePadding(bytes: Uint8Array): Uint8Array {
  const idx = bytes.indexOf(0);
  return idx >= 0 ? bytes.slice(0, idx) : bytes;
}

function stripUtf16Padding(bytes: Uint8Array): Uint8Array {
  const usable = bytes.length - (bytes.length % 2);
  for (let i = 0; i + 1 < usable; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) {
      return bytes.slice(0, i);
    }
  }
  return bytes.slice(0, usable);
}

function decodeUtf16Payload(rawPayload: Uint8Array, preferBigEndian: boolean): string {
  let payload = rawPayload;
  let useBe = preferBigEndian;

  // Inspect explicit UTF-16 BOM and always strip it before decoding
  if (payload.length >= 2) {
    if (payload[0] === 0xfe && payload[1] === 0xff) {
      useBe = true;
      payload = payload.slice(2);
    } else if (payload[0] === 0xff && payload[1] === 0xfe) {
      useBe = false;
      payload = payload.slice(2);
    }
  }

  payload = stripUtf16Padding(payload);
  if (payload.length < 2) return '';

  // Safeguard against mis-tagged BOM-less UTF-16 strings by checking null-byte lane distribution
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i + 1 < payload.length; i += 2) {
    if (payload[i] === 0x00 && payload[i + 1] >= 0x20 && payload[i + 1] <= 0x7e) {
      evenZeros++;
    }
    if (payload[i + 1] === 0x00 && payload[i] >= 0x20 && payload[i] <= 0x7e) {
      oddZeros++;
    }
  }
  if (evenZeros > oddZeros && evenZeros >= 2) {
    useBe = true;
  } else if (oddZeros > evenZeros && oddZeros >= 2) {
    useBe = false;
  }

  const label = useBe ? 'utf-16be' : 'utf-16le';
  try {
    const rawDecoded = new TextDecoder(label).decode(payload);
    const hadCorruption = looksLikeMojibake(rawDecoded);
    const repaired = repairMojibakeText(rawDecoded);
    if (hadCorruption && /[\u3400-\u9FFF\uF900-\uFAFF]/.test(repaired) && !/[a-zA-Z]/.test(repaired)) {
      return '';
    }
    return repaired;
  } catch {
    const fallback = new TextDecoder(useBe ? 'utf-16le' : 'utf-16be').decode(payload);
    return repairMojibakeText(fallback);
  }
}

function decodeTextFrame(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const encoding = bytes[0];
  const payload = bytes.slice(1);
  if (payload.length === 0) return '';

  try {
    if (encoding === 0) {
      const trimmed = stripSingleBytePadding(payload);
      // Many MP3 taggers store UTF-8 under encoding byte 0; prefer UTF-8 if multi-byte sequences are valid
      let hasHighBit = false;
      for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] >= 0x80) {
          hasHighBit = true;
          break;
        }
      }
      if (hasHighBit) {
        try {
          const utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(trimmed);
          const repairedUtf8 = repairMojibakeText(utf8Text);
          if (repairedUtf8 && !looksLikeMojibake(repairedUtf8)) {
            return repairedUtf8;
          }
        } catch {
          // Not valid UTF-8; use ISO-8859-1 below
        }
      }
      return repairMojibakeText(new TextDecoder('iso-8859-1').decode(trimmed));
    }

    if (encoding === 1) {
      return decodeUtf16Payload(payload, false);
    }

    if (encoding === 2) {
      return decodeUtf16Payload(payload, true);
    }

    if (encoding === 3) {
      const trimmed = stripSingleBytePadding(payload);
      return repairMojibakeText(new TextDecoder('utf-8').decode(trimmed));
    }

    // Fallback when encoding byte itself was corrupted
    return repairMojibakeText(new TextDecoder('utf-8', { fatal: false }).decode(stripSingleBytePadding(bytes)));
  } catch {
    return repairMojibakeText(new TextDecoder('utf-8', { fatal: false }).decode(stripSingleBytePadding(payload)));
  }
}

function removeUnsync(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let len = 0;
  for (let i = 0; i < data.length; i++) {
    out[len++] = data[i];
    if (data[i] === 0xff && i + 1 < data.length && data[i + 1] === 0x00) {
      i++;
    }
  }
  return out.slice(0, len);
}

function readSyncsafe32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

export function parseId3v2Buffer(buffer: ArrayBuffer): Partial<ParsedAudioMetadata> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 10) return {};

  // Check "ID3" header
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return {};
  }

  const majorVersion = bytes[3];
  const tagFlags = bytes[5];
  const tagSize = readSyncsafe32(bytes, 6);
  const rawEnd = Math.min(bytes.length, 10 + tagSize);
  let body: Uint8Array = bytes.slice(10, rawEnd);

  // Global unsynchronisation in ID3v2.3
  if ((tagFlags & 0x80) !== 0 && majorVersion <= 3) {
    body = removeUnsync(body);
  }

  let offset = 0;
  const result: Partial<ParsedAudioMetadata> = {};

  if (majorVersion === 2) {
    while (offset + 6 <= body.length) {
      const frameId = String.fromCharCode(body[offset], body[offset + 1], body[offset + 2]);
      if (!/^[A-Z0-9]{3}$/.test(frameId)) break;
      const frameSize = (body[offset + 3] << 16) | (body[offset + 4] << 8) | body[offset + 5];
      if (frameSize <= 0 || offset + 6 + frameSize > body.length) break;
      const frameData = body.slice(offset + 6, offset + 6 + frameSize);
      const val = decodeTextFrame(frameData);
      if (frameId === 'TT2' && val && !looksLikeMojibake(val)) result.title = val;
      if (frameId === 'TP1' && val && !looksLikeMojibake(val)) result.artist = val;
      if (frameId === 'TAL' && val && !looksLikeMojibake(val)) result.album = val;
      if (frameId === 'TRK' && val) {
        const num = parseInt(val.split('/')[0], 10);
        if (Number.isFinite(num) && num > 0) result.trackNumber = num;
      }
      offset += 6 + frameSize;
    }
    return result;
  }

  if (majorVersion === 3 || majorVersion === 4) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

    // Skip ID3v2.3 / ID3v2.4 Extended Header if present (flag bit 0x40)
    if ((tagFlags & 0x40) !== 0 && body.length >= 4) {
      if (majorVersion === 3) {
        const extSize = view.getUint32(0, false);
        if (extSize > 0 && 4 + extSize < body.length) {
          offset = 4 + extSize;
        }
      } else {
        const extSize = readSyncsafe32(body, 0);
        if (extSize >= 6 && extSize < body.length) {
          offset = extSize;
        }
      }
    }

    while (offset + 10 <= body.length) {
      const frameId = String.fromCharCode(
        body[offset],
        body[offset + 1],
        body[offset + 2],
        body[offset + 3]
      );
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      const frameSize =
        majorVersion === 4 ? readSyncsafe32(body, offset + 4) : view.getUint32(offset + 4, false);
      const frameFlags2 = body[offset + 9];

      if (frameSize <= 0 || offset + 10 + frameSize > body.length) break;
      let frameData: Uint8Array = body.slice(offset + 10, offset + 10 + frameSize);

      if (majorVersion === 4) {
        if ((frameFlags2 & 0x02) !== 0 || (tagFlags & 0x80) !== 0) {
          frameData = removeUnsync(frameData);
        }
        // Skip compressed/encrypted frames that cannot be plaintext-decoded
        if ((frameFlags2 & 0x0c) !== 0) {
          offset += 10 + frameSize;
          continue;
        }
        let headerExtra = 0;
        if ((frameFlags2 & 0x40) !== 0) headerExtra += 1; // Grouping identity
        if ((frameFlags2 & 0x01) !== 0) headerExtra += 4; // Data length indicator
        if (headerExtra > 0 && headerExtra < frameData.length) {
          frameData = frameData.slice(headerExtra);
        }
      }

      if (frameId === 'TIT2' || frameId === 'TPE1' || frameId === 'TALB' || frameId === 'TRCK') {
        const decoded = decodeTextFrame(frameData);
        if (decoded && !looksLikeMojibake(decoded)) {
          if (frameId === 'TIT2') result.title = decoded;
          if (frameId === 'TPE1') result.artist = decoded;
          if (frameId === 'TALB') result.album = decoded;
          if (frameId === 'TRCK') {
            const num = parseInt(decoded.split('/')[0], 10);
            if (Number.isFinite(num) && num > 0) result.trackNumber = num;
          }
        }
      }

      offset += 10 + frameSize;
    }
  }

  return result;
}

export function parseId3v1Tail(buffer: ArrayBuffer): Partial<ParsedAudioMetadata> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 128) return {};
  const start = bytes.length - 128;
  if (bytes[start] !== 0x54 || bytes[start + 1] !== 0x41 || bytes[start + 2] !== 0x47) {
    return {};
  }
  const decoder = new TextDecoder('iso-8859-1');
  const title = repairMojibakeText(decoder.decode(stripSingleBytePadding(bytes.slice(start + 3, start + 33))));
  const artist = repairMojibakeText(decoder.decode(stripSingleBytePadding(bytes.slice(start + 33, start + 63))));
  const album = repairMojibakeText(decoder.decode(stripSingleBytePadding(bytes.slice(start + 63, start + 93))));
  const trackFlag = bytes[start + 125] === 0 ? bytes[start + 126] : undefined;

  return {
    title: title && !looksLikeMojibake(title) ? title : undefined,
    artist: artist && !looksLikeMojibake(artist) ? artist : undefined,
    album: album && !looksLikeMojibake(album) ? album : undefined,
    trackNumber: trackFlag && trackFlag > 0 ? trackFlag : undefined,
  };
}

export function parseFlacVorbisBuffer(buffer: ArrayBuffer): Partial<ParsedAudioMetadata> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 42) return {};
  if (bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) {
    return {};
  }

  let offset = 4;
  const view = new DataView(buffer);
  const result: Partial<ParsedAudioMetadata> = {};

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockLen = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;
    if (offset + blockLen > bytes.length) break;

    if (blockType === 4) {
      let ptr = offset;
      const vendorLen = view.getUint32(ptr, true);
      ptr += 4 + vendorLen;
      if (ptr + 4 <= offset + blockLen) {
        const count = view.getUint32(ptr, true);
        ptr += 4;
        const decoder = new TextDecoder('utf-8');
        for (let i = 0; i < count && ptr + 4 <= offset + blockLen; i++) {
          const itemLen = view.getUint32(ptr, true);
          ptr += 4;
          if (ptr + itemLen > offset + blockLen) break;
          const entry = decoder.decode(bytes.slice(ptr, ptr + itemLen));
          ptr += itemLen;
          const eqIdx = entry.indexOf('=');
          if (eqIdx > 0) {
            const key = entry.slice(0, eqIdx).toUpperCase();
            const val = repairMojibakeText(entry.slice(eqIdx + 1));
            if (key === 'TITLE' && val) result.title = val;
            if (key === 'ARTIST' && val) result.artist = val;
            if (key === 'ALBUM' && val) result.album = val;
            if (key === 'TRACKNUMBER' && val) {
              const n = parseInt(val.split('/')[0], 10);
              if (Number.isFinite(n) && n > 0) result.trackNumber = n;
            }
          }
        }
      }
      break;
    }

    offset += blockLen;
    if (isLast) break;
  }

  return result;
}

export async function readAudioFileTags(file: File | Blob, folderName?: string, fileNameOverride?: string): Promise<ParsedAudioMetadata> {
  const rawName = fileNameOverride || (file instanceof File ? file.name : 'Unknown Track.mp3');
  const sanitized = sanitizeFilename(rawName, folderName || 'Local Import');

  try {
    const headSlice = await file.slice(0, Math.min(file.size, 131072)).arrayBuffer();
    let tags = parseId3v2Buffer(headSlice);

    if (!tags.title && !tags.artist) {
      const flacTags = parseFlacVorbisBuffer(headSlice);
      if (flacTags.title || flacTags.artist) {
        tags = flacTags;
      }
    }

    if (!tags.title && file.size >= 128) {
      const tailSlice = await file.slice(file.size - 128, file.size).arrayBuffer();
      const v1Tags = parseId3v1Tail(tailSlice);
      tags = { ...v1Tags, ...tags };
    }

    const safeTitle = tags.title && !looksLikeMojibake(tags.title) ? tags.title : sanitized.title;
    const safeArtist = tags.artist && !looksLikeMojibake(tags.artist) ? tags.artist : sanitized.artist;
    const safeAlbum = tags.album && !looksLikeMojibake(tags.album) ? tags.album : sanitized.album;

    return {
      title: safeTitle,
      artist: safeArtist,
      album: safeAlbum,
      trackNumber: tags.trackNumber,
    };
  } catch {
    return {
      title: sanitized.title,
      artist: sanitized.artist,
      album: sanitized.album,
    };
  }
}

export function inferFilenameFromTrackId(trackId: string): string {
  // Format generated by App/FolderScannerView: local-<filename>-<size>-<lastModified>
  const stripped = trackId.replace(/^local-/, '').replace(/-\d+-\d+$/, '');
  return stripped.replace(/_(mp3|flac|wav|ogg|m4a|aac|opus|webm)$/i, '.$1');
}

export async function repairCorruptedTrack(track: Track, storedBlob?: Blob): Promise<Track | null> {
  if (track.source !== 'local') return null;

  const needsRepair =
    looksLikeMojibake(track.title) ||
    looksLikeMojibake(track.artist) ||
    looksLikeMojibake(track.album);

  if (!needsRepair) return null;

  const inferredName = inferFilenameFromTrackId(track.id);
  const folderLabel = track.folderPath || 'Picked Songs';

  if (storedBlob) {
    const reparsed = await readAudioFileTags(storedBlob, folderLabel, inferredName);
    return {
      ...track,
      title: reparsed.title,
      artist: reparsed.artist,
      album: reparsed.album,
      trackNumber: reparsed.trackNumber ?? track.trackNumber,
    };
  }

  const sanitized = sanitizeFilename(inferredName, folderLabel);
  const fixField = (val: string, fallback: string): string => {
    const hadCorruption = looksLikeMojibake(val);
    const repaired = repairMojibakeText(val);
    if (!repaired || looksLikeMojibake(repaired)) return fallback;
    if (
      hadCorruption &&
      /[\u3400-\u9FFF\uF900-\uFAFF]/.test(repaired) &&
      !/[a-zA-Z]/.test(repaired)
    ) {
      return fallback;
    }
    return repaired;
  };

  return {
    ...track,
    title: fixField(track.title, sanitized.title),
    artist: fixField(track.artist, sanitized.artist),
    album: fixField(track.album, sanitized.album),
  };
}
