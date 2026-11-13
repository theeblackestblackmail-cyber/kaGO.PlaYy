import { sanitizeFilename } from './filenameSanitizer';

export interface ParsedAudioMetadata {
  title: string;
  artist: string;
  album: string;
  trackNumber?: number;
}

function decodeTextFrame(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const encoding = bytes[0];
  const payload = bytes.slice(1);
  try {
    if (encoding === 0) {
      return new TextDecoder('iso-8859-1').decode(payload).replace(/\0/g, '').trim();
    }
    if (encoding === 1) {
      return new TextDecoder('utf-16').decode(payload).replace(/\0/g, '').trim();
    }
    if (encoding === 2) {
      return new TextDecoder('utf-16be').decode(payload).replace(/\0/g, '').trim();
    }
    return new TextDecoder('utf-8').decode(payload).replace(/\0/g, '').trim();
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(payload).replace(/\0/g, '').trim();
  }
}

export function parseId3v2Buffer(buffer: ArrayBuffer): Partial<ParsedAudioMetadata> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 10) return {};

  // Check "ID3" header
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return {};
  }

  const majorVersion = bytes[3];
  const tagSize =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);

  const end = Math.min(bytes.length, 10 + tagSize);
  let offset = 10;
  const result: Partial<ParsedAudioMetadata> = {};

  if (majorVersion === 3 || majorVersion === 4) {
    while (offset + 10 <= end) {
      const frameId = String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3]
      );
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      const frameSize =
        majorVersion === 4
          ? ((bytes[offset + 4] & 0x7f) << 21) |
            ((bytes[offset + 5] & 0x7f) << 14) |
            ((bytes[offset + 6] & 0x7f) << 7) |
            (bytes[offset + 7] & 0x7f)
          : view.getUint32(offset + 4, false);

      if (frameSize <= 0 || offset + 10 + frameSize > end) break;
      const frameData = bytes.slice(offset + 10, offset + 10 + frameSize);

      if (frameId === 'TIT2') result.title = decodeTextFrame(frameData);
      if (frameId === 'TPE1') result.artist = decodeTextFrame(frameData);
      if (frameId === 'TALB') result.album = decodeTextFrame(frameData);
      if (frameId === 'TRCK') {
        const rawTrk = decodeTextFrame(frameData);
        const num = parseInt(rawTrk.split('/')[0], 10);
        if (Number.isFinite(num) && num > 0) result.trackNumber = num;
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
  const title = decoder.decode(bytes.slice(start + 3, start + 33)).replace(/\0/g, '').trim();
  const artist = decoder.decode(bytes.slice(start + 33, start + 63)).replace(/\0/g, '').trim();
  const album = decoder.decode(bytes.slice(start + 63, start + 93)).replace(/\0/g, '').trim();
  const trackFlag = bytes[start + 125] === 0 ? bytes[start + 126] : undefined;

  return {
    title: title || undefined,
    artist: artist || undefined,
    album: album || undefined,
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

    // Vorbis comment block = 4
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
            const val = entry.slice(eqIdx + 1).trim();
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

export async function readAudioFileTags(file: File, folderName?: string): Promise<ParsedAudioMetadata> {
  const sanitized = sanitizeFilename(file.name, folderName || 'Local Import');

  try {
    // Only read the first 128KB and last 128B so large FLAC/WAV files never load into memory
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

    return {
      title: tags.title || sanitized.title,
      artist: tags.artist || sanitized.artist,
      album: tags.album || sanitized.album,
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
