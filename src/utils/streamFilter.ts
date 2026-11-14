import type {
  StreamArtistResult,
  StreamSearchCategory,
  StudioQueueItem,
  Track,
} from '../types/audio';

const MIX_OR_PLAYLIST_RE =
  /\b(full\s*album|full\s*mix|dj\s*mix|dj\s*set|megamix|nonstop|non-stop|compilation|playlist|1\s*hour|2\s*hours|continuous\s*mix|mashup\s*mix|radio\s*show|podcast|episode\s*\d+|tutorial|recreating|how\s+to\s+(make|produce)|reaction|track\s*breakdown)\b/i;

const DERIVATIVE_UPLOAD_RE =
  /\b(type\s*beat|karaoke|instrumental\s*cover|piano\s*cover|guitar\s*cover|violin\s*cover|drum\s*cover|8d\s*audio|slowed\s*(\+|and)?\s*reverb|sped\s*up|nightcore|ai\s*cover|cover\s*by|parody|tribute)\b/i;

export function isIndividualSong(
  title: string,
  collectionName?: string,
  durationSeconds?: number
): boolean {
  if (!title || !title.trim()) return false;
  if (MIX_OR_PLAYLIST_RE.test(title)) return false;
  if (collectionName && /\b(dj\s*mix|continuous\s*mix|podcast)\b/i.test(collectionName)) {
    return false;
  }
  // Exclude 30s preview clips (< 45s) and long mixes (> 15 minutes)
  if (typeof durationSeconds === 'number' && (durationSeconds < 45 || durationSeconds > 900)) {
    return false;
  }
  return true;
}

export function sortStudioQueue(items: StudioQueueItem[]): StudioQueueItem[] {
  return [...items].sort((a, b) => {
    if (b.upvotes !== a.upvotes) {
      return b.upvotes - a.upvotes;
    }
    return a.addedAt - b.addedAt;
  });
}

export function parseYouTubeDuration(text?: string): number {
  if (!text) return 0;
  const cleaned = text.trim();
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(cleaned)) return 0;
  const parts = cleaned.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

export function parseYouTubeViewCount(text?: string): number {
  if (!text) return 0;
  const normalized = text.replace(/,/g, '').trim().toUpperCase();
  const abbrMatch = normalized.match(/(\d+(?:\.\d+)?)\s*([KMB])\b/);
  if (abbrMatch) {
    const val = parseFloat(abbrMatch[1]);
    const mult =
      abbrMatch[2] === 'B' ? 1_000_000_000 : abbrMatch[2] === 'M' ? 1_000_000 : 1_000;
    return Number.isFinite(val) ? Math.round(val * mult) : 0;
  }
  const digitsMatch = normalized.match(/(\d+)\s*VIEW/);
  if (digitsMatch) {
    const val = parseInt(digitsMatch[1], 10);
    return Number.isFinite(val) ? val : 0;
  }
  return 0;
}

export function parseYouTubeArtistAndTitle(
  rawTitle: string,
  channelName: string
): { artist: string; title: string } {
  const cleanChannel = channelName.replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube Audio';
  const stripped = rawTitle
    .replace(
      /\s*[\[(](official\s*(music\s*)?(video|audio|lyric\s*video)|lyrics?|hq|4k|hd|visualizer|audio\s*only)[\])]/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();

  const dashMatch = stripped.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashMatch && dashMatch[1].trim().length >= 2 && dashMatch[2].trim().length >= 2) {
    return {
      artist: dashMatch[1].trim(),
      title: dashMatch[2].trim(),
    };
  }

  return {
    artist: cleanChannel,
    title: stripped || rawTitle.trim(),
  };
}

export interface ParsedYouTubeVideo {
  videoId: string;
  title: string;
  artist: string;
  durationSeconds: number;
  thumbnailUrl: string;
  viewCount?: number;
  isOfficial?: boolean;
  channelName?: string;
}

interface YouTubeTextRun {
  text?: string;
}

interface YouTubeOwnerBadge {
  metadataBadgeRenderer?: {
    style?: string;
    tooltip?: string;
  };
}

interface YouTubeVideoRenderer {
  videoId?: string;
  title?: { runs?: YouTubeTextRun[]; simpleText?: string };
  ownerText?: { runs?: YouTubeTextRun[] };
  shortBylineText?: { runs?: YouTubeTextRun[] };
  longBylineText?: { runs?: YouTubeTextRun[] };
  lengthText?: { simpleText?: string };
  viewCountText?: { simpleText?: string; runs?: YouTubeTextRun[] };
  shortViewCountText?: { simpleText?: string; runs?: YouTubeTextRun[] };
  ownerBadges?: YouTubeOwnerBadge[];
}

function extractYtInitialDataJson(html: string): Record<string, unknown> | null {
  const match =
    html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/) ||
    html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isOfficialYouTubeUpload(v: YouTubeVideoRenderer, rawTitle: string, channelName: string): boolean {
  if (/-\s*Topic$/i.test(channelName) || /vevo$/i.test(channelName)) return true;
  if (/\bofficial\s*(music\s*)?(video|audio|lyric)/i.test(rawTitle)) return true;
  if (Array.isArray(v.ownerBadges)) {
    for (const badge of v.ownerBadges) {
      const style = badge?.metadataBadgeRenderer?.style || '';
      const tip = badge?.metadataBadgeRenderer?.tooltip || '';
      if (
        style.includes('VERIFIED_ARTIST') ||
        style.includes('VERIFIED') ||
        /official\s*artist/i.test(tip)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function extractYouTubeSearchResults(html: string): ParsedYouTubeVideo[] {
  const data = extractYtInitialDataJson(html);
  if (!data) return [];

  const contents = (
    data as {
      contents?: {
        twoColumnSearchResultsRenderer?: {
          primaryContents?: {
            sectionListRenderer?: {
              contents?: Array<{
                itemSectionRenderer?: {
                  contents?: Array<{ videoRenderer?: YouTubeVideoRenderer }>;
                };
              }>;
            };
          };
        };
      };
    }
  )?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;

  if (!Array.isArray(contents)) return [];

  const seenIds = new Set<string>();
  const results: ParsedYouTubeVideo[] = [];

  for (const section of contents) {
    const items = section?.itemSectionRenderer?.contents;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const v = item?.videoRenderer;
      if (!v?.videoId || seenIds.has(v.videoId)) continue;

      const rawTitle =
        v.title?.runs?.map((r) => r.text || '').join('') || v.title?.simpleText || '';
      const channelName =
        v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '';
      const durationSeconds = parseYouTubeDuration(v.lengthText?.simpleText);

      if (!rawTitle || durationSeconds <= 0) continue;
      if (!isIndividualSong(rawTitle, channelName, durationSeconds)) continue;

      const { artist, title } = parseYouTubeArtistAndTitle(rawTitle, channelName);
      if (!isIndividualSong(title, artist, durationSeconds)) continue;

      const viewText =
        v.viewCountText?.simpleText ||
        v.viewCountText?.runs?.map((r) => r.text || '').join('') ||
        v.shortViewCountText?.simpleText ||
        v.shortViewCountText?.runs?.map((r) => r.text || '').join('') ||
        '';
      const viewCount = parseYouTubeViewCount(viewText);
      const isOfficial = isOfficialYouTubeUpload(v, rawTitle, channelName);

      seenIds.add(v.videoId);
      results.push({
        videoId: v.videoId,
        title,
        artist,
        durationSeconds,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        viewCount,
        isOfficial,
        channelName,
      });
    }
  }

  return results;
}

function oneEditOrMatch(word: string, target: string): boolean {
  if (target === word || target.includes(word)) return true;
  if (word.length < 5) return false;
  // Prefix match for longer words (e.g. truncated surname)
  if (target.startsWith(word.slice(0, word.length - 1))) return true;
  // Edit distance <= 1 (handles typos like "wangeci" vs "wangechi")
  if (Math.abs(target.length - word.length) > 1) return false;
  let i = 0;
  let j = 0;
  let diffs = 0;
  while (i < word.length && j < target.length) {
    if (word[i] === target[j]) {
      i++;
      j++;
    } else {
      diffs++;
      if (diffs > 1) return false;
      if (word.length > target.length) i++;
      else if (target.length > word.length) j++;
      else {
        i++;
        j++;
      }
    }
  }
  diffs += (word.length - i) + (target.length - j);
  return diffs <= 1;
}

function tokenMatchScore(token: string, haystackWords: string[], haystack: string): number {
  if (haystackWords.includes(token)) return 1.0;
  if (token.length >= 4 && haystack.includes(token)) return 0.9;
  for (const hw of haystackWords) {
    if (oneEditOrMatch(token, hw)) return 0.85;
  }
  return 0;
}

export function buildCategorySearchPlan(
  query: string,
  genre: string,
  category: StreamSearchCategory = 'all'
): { searchQuery: string; sp?: string; targetCategory: StreamSearchCategory } {
  const cleanQ = query.trim();
  const baseTerm = [cleanQ, genre ? `${genre} music` : ''].filter(Boolean).join(' ') || 'top music hits';

  switch (category) {
    case 'songs':
      return {
        searchQuery: [cleanQ, genre ? `${genre} music` : '', cleanQ ? 'official audio' : 'top hits songs']
          .filter(Boolean)
          .join(' '),
        sp: 'EgIQAQ%3D%3D',
        targetCategory: category,
      };
    case 'videos':
      return {
        searchQuery: [cleanQ, genre ? `${genre} music` : '', 'official music video']
          .filter(Boolean)
          .join(' '),
        sp: 'EgIQAQ%3D%3D',
        targetCategory: category,
      };
    case 'albums':
      return {
        searchQuery: [cleanQ || genre || 'popular', 'full album'].filter(Boolean).join(' '),
        sp: undefined,
        targetCategory: category,
      };
    case 'artists':
      return {
        searchQuery: cleanQ || (genre ? `${genre} artist` : 'top music artists'),
        sp: 'EgIQAg%3D%3D',
        targetCategory: category,
      };
    case 'playlists':
      return {
        searchQuery: [cleanQ || genre || 'popular music', 'playlist'].filter(Boolean).join(' '),
        sp: 'EgIQAw%3D%3D',
        targetCategory: category,
      };
    case 'featured_playlists':
      return {
        searchQuery: [cleanQ || genre || 'top hits', 'official playlist mix']
          .filter(Boolean)
          .join(' '),
        sp: 'EgIQAw%3D%3D',
        targetCategory: category,
      };
    case 'podcasts':
      return {
        searchQuery: [cleanQ || genre || 'music', 'podcast full episode']
          .filter(Boolean)
          .join(' '),
        sp: 'EgIQAQ%3D%3D',
        targetCategory: category,
      };
    case 'all':
    default:
      return {
        searchQuery: baseTerm,
        sp: undefined,
        targetCategory: 'all',
      };
  }
}

export function rankYouTubeSearchResults(
  results: ParsedYouTubeVideo[],
  query: string,
  category: StreamSearchCategory = 'all'
): ParsedYouTubeVideo[] {
  const cleanQuery = query.trim().toLowerCase();
  const queryWantsDerivative =
    DERIVATIVE_UPLOAD_RE.test(cleanQuery) || /\b(cover|remix|live)\b/i.test(cleanQuery);
  const queryTokens = cleanQuery.split(/[^a-z0-9]+/i).filter((t) => t.length >= 2);

  // Drop obvious unofficial derivative uploads unless user specifically asked for them
  const primaryPool = queryWantsDerivative
    ? results
    : results.filter(
        (r) => !DERIVATIVE_UPLOAD_RE.test(`${r.title} ${r.artist} ${r.channelName || ''}`)
      );

  const pool = primaryPool.length > 0 ? primaryPool : results;

  const scoreItem = (item: ParsedYouTubeVideo, index: number): number => {
    const haystack = `${item.artist} ${item.title} ${item.channelName || ''}`.toLowerCase();
    const haystackWords = haystack.split(/[^a-z0-9]+/i).filter((w) => w.length >= 2);
    let score = 0;

    // 1. Typo-tolerant word relevance match against search terms
    if (queryTokens.length > 0) {
      let matchedSum = 0;
      let longTokensCount = 0;
      let longTokensMatched = 0;
      for (const tok of queryTokens) {
        const ts = tokenMatchScore(tok, haystackWords, haystack);
        matchedSum += ts;
        if (tok.length >= 4) {
          longTokensCount++;
          if (ts > 0) longTokensMatched++;
        }
      }
      const matchRatio = matchedSum / queryTokens.length;
      score += matchRatio * 75;
      if (matchRatio >= 0.85) score += 28;
      if (longTokensCount > 0 && longTokensMatched === longTokensCount) score += 24;
      if (cleanQuery.length >= 4 && haystack.includes(cleanQuery)) score += 16;
    }

    // 2. Strong Official Artist / VEVO / - Topic boost
    if (item.isOfficial) score += 34;
    if (/-\s*topic$/i.test(item.channelName || '')) {
      score += category === 'songs' ? 18 : 8;
    }

    // 3. Strong View-Count Popularity Ranking so popular hit singles surface straight to the top
    const views = item.viewCount || 0;
    if (views > 0) {
      score += Math.log10(views + 1) * 14;
      if (views >= 100_000_000) score += 36;
      else if (views >= 10_000_000) score += 26;
      else if (views >= 1_000_000) score += 16;
      else if (views >= 100_000) score += 8;
    }

    // 4. Category-specific ranking adjustments
    if (category === 'videos' && /\b(official\s*(music\s*)?video|vevo)\b/i.test(haystack)) {
      score += 22;
    } else if (category === 'songs' && /\b(official\s*audio|-\s*topic)\b/i.test(haystack)) {
      score += 18;
    }

    // 5. Penalize unofficial covers / karaoke / tributes when user didn't search for them
    if (!queryWantsDerivative && /\b(cover|karaoke|instrumental|tribute|parody)\b/i.test(haystack)) {
      score -= 42;
    }

    // 6. Mild tie-breaker preserving YouTube's organic top ordering
    score -= index * 0.25;
    return score;
  };

  return [...pool]
    .map((item, idx) => ({ item, score: scoreItem(item, idx) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

export function toYouTubeTracks(
  items: ParsedYouTubeVideo[],
  genre?: string,
  options: { autoQueued?: boolean; albumLabel?: string } = {}
): Track[] {
  const { autoQueued = false, albumLabel = 'YouTube Music Stream' } = options;
  return items.map((item) => ({
    id: `yt-${item.videoId}`,
    youtubeId: item.videoId,
    streamProvider: 'youtube' as const,
    title: item.title,
    artist: item.artist,
    album: albumLabel,
    duration: item.durationSeconds,
    source: 'stream' as const,
    artworkUrl: item.thumbnailUrl,
    genre: genre || 'YouTube',
    addedAt: Date.now(),
    viewCount: item.viewCount,
    isOfficial: item.isOfficial,
    ...(autoQueued ? { autoQueued: true } : {}),
  }));
}

export function parseYouTubeSuggestResponse(rawText: string): string[] {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
      return parsed[1]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 7);
    }
    return [];
  } catch {
    return [];
  }
}

function collectCompactRenderers(node: unknown, out: YouTubeVideoRenderer[], depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 24) return;
  if (Array.isArray(node)) {
    for (const item of node) collectCompactRenderers(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.compactVideoRenderer && typeof obj.compactVideoRenderer === 'object') {
    out.push(obj.compactVideoRenderer as YouTubeVideoRenderer);
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      collectCompactRenderers(val, out, depth + 1);
    }
  }
}

export function extractYouTubeRelatedResults(
  html: string,
  excludeVideoId?: string
): ParsedYouTubeVideo[] {
  const data = extractYtInitialDataJson(html);
  if (!data) return [];

  const secondary = (
    data as {
      contents?: {
        twoColumnWatchNextResults?: {
          secondaryResults?: unknown;
        };
      };
    }
  )?.contents?.twoColumnWatchNextResults?.secondaryResults;

  if (!secondary) return [];

  const renderers: YouTubeVideoRenderer[] = [];
  collectCompactRenderers(secondary, renderers);

  const seenIds = new Set<string>(excludeVideoId ? [excludeVideoId] : []);
  const results: ParsedYouTubeVideo[] = [];

  for (const v of renderers) {
    if (!v.videoId || seenIds.has(v.videoId)) continue;

    const rawTitle =
      v.title?.simpleText || v.title?.runs?.map((r) => r.text || '').join('') || '';
    const channelName =
      v.shortBylineText?.runs?.[0]?.text ||
      v.longBylineText?.runs?.[0]?.text ||
      v.ownerText?.runs?.[0]?.text ||
      '';
    const durationSeconds = parseYouTubeDuration(v.lengthText?.simpleText);

    if (!rawTitle || durationSeconds <= 0) continue;
    if (!isIndividualSong(rawTitle, channelName, durationSeconds)) continue;

    const { artist, title } = parseYouTubeArtistAndTitle(rawTitle, channelName);
    if (!isIndividualSong(title, artist, durationSeconds)) continue;

    const viewText =
      v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '';

    seenIds.add(v.videoId);
    results.push({
      videoId: v.videoId,
      title,
      artist,
      durationSeconds,
      thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      viewCount: parseYouTubeViewCount(viewText),
      isOfficial: isOfficialYouTubeUpload(v, rawTitle, channelName),
      channelName,
    });
  }

  return results;
}

export function buildRadioSeedQuery(track: Pick<Track, 'title' | 'artist' | 'genre'>): string {
  const cleanArtist = (track.artist || '')
    .replace(/\b(youTube\s*audio|official|topic|vevo)\b/gi, '')
    .trim();
  const cleanGenre =
    track.genre && track.genre.toLowerCase() !== 'youtube' && track.genre.toLowerCase() !== 'stream'
      ? track.genre.trim()
      : '';

  if (cleanArtist && cleanGenre) {
    return `${cleanArtist} ${cleanGenre} songs`;
  }
  if (cleanArtist) {
    return `${cleanArtist} similar songs music`;
  }
  if (cleanGenre) {
    return `${cleanGenre} popular songs`;
  }
  return `${track.title} similar songs`;
}

export function mergeAutoplayQueue(
  existingQueue: Track[],
  currentTrack: Track,
  relatedTracks: Track[],
  options: { replaceExistingAuto?: boolean; maxAutoTracks?: number } = {}
): Track[] {
  const { replaceExistingAuto = true, maxAutoTracks = 10 } = options;

  const baseQueue = existingQueue.filter((item) => {
    if (item.id === currentTrack.id) return true;
    if (replaceExistingAuto && item.autoQueued) return false;
    return true;
  });

  if (!baseQueue.some((item) => item.id === currentTrack.id)) {
    baseQueue.unshift(currentTrack);
  }

  const seenIds = new Set(baseQueue.map((item) => item.id));
  const seenYoutubeIds = new Set(
    baseQueue.map((item) => item.youtubeId).filter((id): id is string => Boolean(id))
  );

  const additions: Track[] = [];
  for (const candidate of relatedTracks) {
    if (additions.length >= maxAutoTracks) break;
    if (seenIds.has(candidate.id)) continue;
    if (candidate.youtubeId && seenYoutubeIds.has(candidate.youtubeId)) continue;

    seenIds.add(candidate.id);
    if (candidate.youtubeId) seenYoutubeIds.add(candidate.youtubeId);
    additions.push({ ...candidate, autoQueued: true });
  }

  return [...baseQueue, ...additions];
}

export function shouldAutoResumeBackgroundPause(params: {
  isPlaying: boolean;
  visibilityState: string;
  now: number;
  backgroundTransitionUntil: number;
  userPausedAt: number;
}): boolean {
  if (!params.isPlaying) return false;
  if (params.userPausedAt > 0 && params.now - params.userPausedAt < 2000) {
    return false;
  }
  return (
    params.visibilityState !== 'visible' ||
    params.now < params.backgroundTransitionUntil
  );
}

interface YouTubeThumbnail {
  url?: string;
}

interface YouTubeChannelRenderer {
  channelId?: string;
  title?: { simpleText?: string; runs?: YouTubeTextRun[] };
  thumbnail?: { thumbnails?: YouTubeThumbnail[] };
  subscriberCountText?: { simpleText?: string; runs?: YouTubeTextRun[] };
  ownerBadges?: YouTubeOwnerBadge[];
}

interface YouTubePlaylistRenderer {
  playlistId?: string;
  title?: { simpleText?: string; runs?: YouTubeTextRun[] };
  shortBylineText?: { runs?: YouTubeTextRun[] };
  longBylineText?: { runs?: YouTubeTextRun[] };
  videoCount?: string;
  videoCountText?: { runs?: YouTubeTextRun[]; simpleText?: string };
  thumbnails?: Array<{ thumbnails?: YouTubeThumbnail[] }>;
  thumbnail?: { thumbnails?: YouTubeThumbnail[] };
}

function normalizeYtThumb(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function collectNodesByKey(
  node: unknown,
  key: string,
  out: unknown[],
  depth = 0
): void {
  if (!node || typeof node !== 'object' || depth > 24) return;
  if (Array.isArray(node)) {
    for (const item of node) collectNodesByKey(item, key, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj[key] && typeof obj[key] === 'object') {
    out.push(obj[key]);
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      collectNodesByKey(val, key, out, depth + 1);
    }
  }
}

export function extractYouTubeArtists(html: string): StreamArtistResult[] {
  const data = extractYtInitialDataJson(html);
  if (!data) return [];

  const channels: YouTubeChannelRenderer[] = [];
  collectNodesByKey(data, 'channelRenderer', channels);

  const seen = new Set<string>();
  const out: StreamArtistResult[] = [];
  for (const ch of channels) {
    const name = (
      ch.title?.simpleText ||
      ch.title?.runs?.map((r) => r.text || '').join('') ||
      ''
    )
      .replace(/\s*-\s*Topic$/i, '')
      .trim();
    const id = ch.channelId || name.toLowerCase();
    if (!name || seen.has(id)) continue;
    seen.add(id);

    const thumbs = ch.thumbnail?.thumbnails || [];
    const thumb = normalizeYtThumb(thumbs[thumbs.length - 1]?.url);
    const subText =
      ch.subscriberCountText?.simpleText ||
      ch.subscriberCountText?.runs?.map((r) => r.text || '').join('') ||
      'Artist';

    let isOfficial = false;
    for (const b of ch.ownerBadges || []) {
      const style = b?.metadataBadgeRenderer?.style || '';
      const tip = b?.metadataBadgeRenderer?.tooltip || '';
      if (style.includes('VERIFIED') || /official\s*artist/i.test(tip)) {
        isOfficial = true;
        break;
      }
    }

    out.push({
      id: `artist-${id}`,
      name,
      channelId: ch.channelId,
      thumbnailUrl: thumb,
      subscriberText: subText,
      isOfficial,
    });
  }

  return out.slice(0, 8);
}

export function extractYouTubeCollections(
  html: string,
  category: StreamSearchCategory,
  genre = ''
): Track[] {
  const data = extractYtInitialDataJson(html);
  if (!data) return [];

  const playlists: YouTubePlaylistRenderer[] = [];
  collectNodesByKey(data, 'playlistRenderer', playlists);

  const seen = new Set<string>();
  const tracks: Track[] = [];
  const resultType: 'album' | 'playlist' = category === 'albums' ? 'album' : 'playlist';

  for (const pl of playlists) {
    if (!pl.playlistId || seen.has(pl.playlistId)) continue;
    const title =
      pl.title?.simpleText || pl.title?.runs?.map((r) => r.text || '').join('') || '';
    if (!title) continue;

    const byline =
      pl.shortBylineText?.runs?.[0]?.text ||
      pl.longBylineText?.runs?.[0]?.text ||
      (category === 'featured_playlists' ? 'Featured Curator' : 'YouTube Music');
    const countRaw =
      pl.videoCount ||
      pl.videoCountText?.simpleText ||
      pl.videoCountText?.runs?.map((r) => r.text || '').join('') ||
      '';
    const countMatch = countRaw.match(/(\d+)/);
    const trackCount = countMatch ? parseInt(countMatch[1], 10) : undefined;

    const nestedThumbs = pl.thumbnails?.[0]?.thumbnails || pl.thumbnail?.thumbnails || [];
    const artworkUrl = normalizeYtThumb(nestedThumbs[nestedThumbs.length - 1]?.url);

    seen.add(pl.playlistId);
    tracks.push({
      id: `ytpl-${pl.playlistId}`,
      youtubePlaylistId: pl.playlistId,
      streamProvider: 'youtube',
      title,
      artist: byline.replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube Music',
      album: category === 'albums' ? 'Full Album' : 'Playlist Collection',
      duration: (trackCount || 10) * 180,
      trackCount,
      resultType,
      source: 'stream',
      artworkUrl,
      genre: genre || (category === 'albums' ? 'Album' : 'Playlist'),
      addedAt: Date.now(),
      isOfficial: /vevo|topic|official/i.test(byline) || category === 'featured_playlists',
    });
  }

  // Modern YouTube playlist/album cards use lockupViewModel instead of playlistRenderer
  const lockups: Array<{
    contentId?: string;
    contentType?: string;
    metadata?: {
      lockupMetadataViewModel?: {
        title?: { content?: string };
        metadata?: {
          contentMetadataViewModel?: {
            metadataRows?: Array<{
              metadataParts?: Array<{ text?: { content?: string } }>;
            }>;
          };
        };
      };
    };
    contentImage?: {
      collectionThumbnailViewModel?: {
        primaryThumbnail?: {
          thumbnailViewModel?: {
            image?: { sources?: Array<{ url?: string }> };
            overlays?: Array<{
              thumbnailOverlayBadgeViewModel?: {
                thumbnailBadges?: Array<{
                  thumbnailBadgeViewModel?: { text?: string };
                }>;
              };
            }>;
          };
        };
      };
    };
  }> = [];
  collectNodesByKey(data, 'lockupViewModel', lockups as unknown[]);

  for (const lk of lockups) {
    const playlistId = lk.contentId || '';
    if (!playlistId || playlistId.startsWith('RD') || seen.has(playlistId)) continue;
    if (
      lk.contentType &&
      !lk.contentType.includes('PLAYLIST') &&
      !lk.contentType.includes('ALBUM')
    ) {
      continue;
    }

    const title = lk.metadata?.lockupMetadataViewModel?.title?.content?.trim() || '';
    if (!title) continue;

    const firstRowParts =
      lk.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]
        ?.metadataParts || [];
    const byline =
      firstRowParts[0]?.text?.content ||
      (category === 'featured_playlists' ? 'Featured Curator' : 'YouTube Music');

    const thumbVm = lk.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel;
    const sources = thumbVm?.image?.sources || [];
    const artworkUrl = normalizeYtThumb(sources[sources.length - 1]?.url);

    let badgeText = '';
    for (const ov of thumbVm?.overlays || []) {
      const t = ov?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text;
      if (t) {
        badgeText = t;
        break;
      }
    }
    const countMatch = badgeText.match(/(\d+)/);
    const trackCount = countMatch ? parseInt(countMatch[1], 10) : undefined;

    seen.add(playlistId);
    tracks.push({
      id: `ytpl-${playlistId}`,
      youtubePlaylistId: playlistId,
      streamProvider: 'youtube',
      title,
      artist: byline.replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube Music',
      album: category === 'albums' ? 'Full Album' : 'Playlist Collection',
      duration: (trackCount || 10) * 180,
      trackCount,
      resultType,
      source: 'stream',
      artworkUrl,
      genre: genre || (category === 'albums' ? 'Album' : 'Playlist'),
      addedAt: Date.now(),
      isOfficial: /vevo|topic|official|album/i.test(`${byline} ${title}`) || category === 'featured_playlists',
    });
  }

  // Also include full-album long-form videos when browsing Albums if playlists are scarce
  if (category === 'albums' && tracks.length < 6) {
    const videos: YouTubeVideoRenderer[] = [];
    collectNodesByKey(data, 'videoRenderer', videos);
    for (const v of videos) {
      if (!v.videoId || seen.has(v.videoId)) continue;
      const rawTitle =
        v.title?.runs?.map((r) => r.text || '').join('') || v.title?.simpleText || '';
      const channelName =
        v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '';
      const durationSeconds = parseYouTubeDuration(v.lengthText?.simpleText);
      if (!rawTitle || durationSeconds < 420) continue;
      if (/\b(podcast|episode|interview)\b/i.test(rawTitle)) continue;

      seen.add(v.videoId);
      const { artist, title } = parseYouTubeArtistAndTitle(rawTitle, channelName);
      const viewText =
        v.viewCountText?.simpleText ||
        v.viewCountText?.runs?.map((r) => r.text || '').join('') ||
        '';
      tracks.push({
        id: `yt-${v.videoId}`,
        youtubeId: v.videoId,
        streamProvider: 'youtube',
        title,
        artist,
        album: 'Full Album',
        duration: durationSeconds,
        resultType: 'album',
        source: 'stream',
        artworkUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        genre: genre || 'Album',
        addedAt: Date.now(),
        viewCount: parseYouTubeViewCount(viewText),
        isOfficial: isOfficialYouTubeUpload(v, rawTitle, channelName),
      });
    }
  }

  return tracks.slice(0, 15);
}

export function extractYouTubePodcasts(html: string, genre = ''): Track[] {
  const data = extractYtInitialDataJson(html);
  if (!data) return [];

  const videos: YouTubeVideoRenderer[] = [];
  collectNodesByKey(data, 'videoRenderer', videos);

  const seen = new Set<string>();
  const out: Track[] = [];
  for (const v of videos) {
    if (!v.videoId || seen.has(v.videoId)) continue;
    const rawTitle =
      v.title?.runs?.map((r) => r.text || '').join('') || v.title?.simpleText || '';
    const channelName =
      v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || 'Podcast';
    const durationSeconds = parseYouTubeDuration(v.lengthText?.simpleText);
    if (!rawTitle || durationSeconds < 90 || durationSeconds > 14_400) continue;

    seen.add(v.videoId);
    const { artist, title } = parseYouTubeArtistAndTitle(rawTitle, channelName);
    const viewText =
      v.viewCountText?.simpleText ||
      v.viewCountText?.runs?.map((r) => r.text || '').join('') ||
      '';
    out.push({
      id: `yt-${v.videoId}`,
      youtubeId: v.videoId,
      streamProvider: 'youtube',
      title,
      artist,
      album: 'Podcast Episode',
      duration: durationSeconds,
      resultType: 'podcast',
      source: 'stream',
      artworkUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      genre: genre || 'Podcast',
      addedAt: Date.now(),
      viewCount: parseYouTubeViewCount(viewText),
      isOfficial: isOfficialYouTubeUpload(v, rawTitle, channelName),
    });
  }

  return out.slice(0, 12);
}

export function extractYouTubePlaylistTracks(html: string, albumLabel = 'Album'): Track[] {
  const data = extractYtInitialDataJson(html);
  if (!data) return [];

  const renderers: Array<{
    videoId?: string;
    title?: { runs?: YouTubeTextRun[]; simpleText?: string };
    shortBylineText?: { runs?: YouTubeTextRun[] };
    lengthText?: { simpleText?: string };
    lengthSeconds?: string;
  }> = [];
  collectNodesByKey(data, 'playlistVideoRenderer', renderers as unknown[]);

  const seen = new Set<string>();
  const out: Track[] = [];
  for (const v of renderers) {
    if (!v.videoId || seen.has(v.videoId)) continue;
    const rawTitle =
      v.title?.runs?.map((r) => r.text || '').join('') || v.title?.simpleText || '';
    const channelName = v.shortBylineText?.runs?.[0]?.text || 'YouTube Music';
    const durationSeconds =
      parseYouTubeDuration(v.lengthText?.simpleText) ||
      (v.lengthSeconds ? parseInt(v.lengthSeconds, 10) : 180) ||
      180;
    if (!rawTitle || durationSeconds < 45) continue;

    seen.add(v.videoId);
    const { artist, title } = parseYouTubeArtistAndTitle(rawTitle, channelName);
    out.push({
      id: `yt-${v.videoId}`,
      youtubeId: v.videoId,
      streamProvider: 'youtube',
      title,
      artist,
      album: albumLabel,
      duration: durationSeconds,
      resultType: 'song',
      source: 'stream',
      artworkUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      genre: 'YouTube',
      addedAt: Date.now(),
      isOfficial: true,
    });
  }

  return out.slice(0, 25);
}

export const MAX_RECENT_SEARCHES = 5;

export function pushRecentSearch(prev: string[], query: string): string[] {
  const clean = query.trim();
  if (!clean) return prev.slice(0, MAX_RECENT_SEARCHES);
  return [clean, ...prev.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(
    0,
    MAX_RECENT_SEARCHES
  );
}

/**
 * Compute full-headroom master preamp gain so playback utilizes maximum clean speaker/headphone volume
 * while avoiding digital square-wave clipping when positive EQ or Bass Boost dB is applied.
 */
export function computeMasterOutputGain(dsp: {
  bands: number[];
  bassBoostEnabled: boolean;
  bassBoostDb: number;
}): number {
  const maxBandBoost = Math.max(0, ...(dsp.bands || []));
  const bassBoost = dsp.bassBoostEnabled ? Math.max(0, dsp.bassBoostDb) : 0;
  const combinedBoost = maxBandBoost + bassBoost * 0.5;
  return Number(Math.max(1.0, Math.min(1.4, 1.38 - combinedBoost * 0.022)).toFixed(3));
}


