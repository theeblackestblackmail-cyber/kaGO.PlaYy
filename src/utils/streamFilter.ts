import type {
  StreamArtistResult,
  StreamSearchCategory,
  StudioQueueItem,
  Track,
} from '../types/audio';

const MIX_OR_PLAYLIST_RE =
  /\b(full\s*album|full\s*mix|dj\s*mix|dj\s*set|megamix|nonstop|non-stop|compilation|playlist|1\s*hour|2\s*hours|continuous\s*mix|mashup\s*mix|radio\s*show|podcast|episode\s*\d+|tutorial|recreating|how\s+to\s+(make|produce)|reaction|track\s*breakdown)\b/i;

const DERIVATIVE_UPLOAD_RE =
  /\b(type\s*beat|karaoke|instrumental\s*cover|piano\s*cover|guitar\s*cover|violin\s*cover|drum\s*cover|vocal\s*cover|acoustic\s*cover|8d\s*audio|432\s*hz|bass\s*boosted|slowed\s*(\+|and|&|n)?\s*reverb|sped\s*up|speed\s*up|spedup|nightcore|chipmunk|ai\s*cover|ai\s*version|cover\s*by|parody|tribute|bootleg|mashup|tiktok\s*(mix|version)|viral\s*mix|reupload|re-upload|ringtone)\b/i;

const VERSION_QUALIFIER_RE =
  /\b(remix|bootleg|mashup|cover|karaoke|instrumental|live|unplugged|acoustic|slowed|reverb|sped\s*up|speed\s*up|nightcore|bass\s*boosted|8d|parody|tribute|reupload|re-upload|ringtone|tiktok|flip|edit|rework|clean\s*version|censored)\b/i;

const JUNK_SUGGESTION_RE =
  /\b(piano\s*tutorial|guitar\s*(lesson|chords|tutorial)|how\s+to\s+play|reaction|lyrics?\s*meaning|meaning\s*explained|karaoke|ringtone|download\s*mp3|mp3\s*download|type\s*beat|slowed|reverb|sped\s*up|speed\s*up|8d\s*audio|nightcore|remix|instrumental|clean|live|cover|mashup|bootleg|bass\s*boosted)\b/i;

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
  const abbrMatch = normalized.match(/(\d+(?:\.\d+)?)\s*([KMB])\b(?:\s*VIEWS?)?/);
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

interface YouTubeTextContainer {
  runs?: YouTubeTextRun[];
  simpleText?: string;
  content?: string;
  accessibility?: {
    accessibilityData?: {
      label?: string;
    };
  };
}

interface YouTubeVideoRenderer {
  videoId?: string;
  title?: YouTubeTextContainer;
  headline?: YouTubeTextContainer;
  ownerText?: YouTubeTextContainer;
  shortBylineText?: YouTubeTextContainer;
  longBylineText?: YouTubeTextContainer;
  lengthText?: YouTubeTextContainer;
  viewCountText?: YouTubeTextContainer;
  shortViewCountText?: YouTubeTextContainer;
  ownerBadges?: YouTubeOwnerBadge[];
  navigationEndpoint?: {
    commandMetadata?: { webCommandMetadata?: { url?: string } };
    reelWatchEndpoint?: unknown;
  };
}

function readYtText(field?: YouTubeTextContainer): string {
  if (!field) return '';
  if (typeof field.simpleText === 'string' && field.simpleText) return field.simpleText;
  if (typeof field.content === 'string' && field.content) return field.content;
  if (Array.isArray(field.runs)) {
    return field.runs.map((r) => r.text || '').join('');
  }
  return '';
}

function extractBalancedJsonObject(source: string, startBraceIdx: number): string | null {
  if (startBraceIdx < 0 || source[startBraceIdx] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(startBraceIdx, i + 1);
      }
    }
  }
  return null;
}

export function extractYtInitialDataJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const markers = [
    /var\s+ytInitialData\s*=\s*\{/,
    /window\s*\[\s*["']ytInitialData["']\s*\]\s*=\s*\{/,
    /window\.ytInitialData\s*=\s*\{/,
  ];

  for (const marker of markers) {
    const m = marker.exec(raw);
    if (!m) continue;
    const braceIdx = m.index + m[0].length - 1;
    const jsonSlice = extractBalancedJsonObject(raw, braceIdx);
    if (!jsonSlice) continue;
    try {
      return JSON.parse(jsonSlice) as Record<string, unknown>;
    } catch {
      // Try next marker
    }
  }

  return null;
}

function isOfficialYouTubeUpload(
  v: Pick<YouTubeVideoRenderer, 'ownerBadges'>,
  channelName: string
): boolean {
  const cleanChannel = channelName.trim();
  if (/-\s*Topic$/i.test(cleanChannel) || /vevo$/i.test(cleanChannel)) return true;
  if (Array.isArray(v.ownerBadges)) {
    for (const badge of v.ownerBadges) {
      const style = badge?.metadataBadgeRenderer?.style || '';
      const tip = badge?.metadataBadgeRenderer?.tooltip || '';
      if (
        style.includes('VERIFIED_ARTIST') ||
        style.includes('VERIFIED') ||
        /official\s*artist/i.test(tip) ||
        /^verified$/i.test(tip.trim())
      ) {
        return true;
      }
    }
  }
  return false;
}

function toParsedVideoFromRenderer(
  v: YouTubeVideoRenderer,
  seenIds: Set<string>
): ParsedYouTubeVideo | null {
  const videoId = v?.videoId?.trim();
  if (!videoId || seenIds.has(videoId)) return null;
  const urlPath = v.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '';
  if (v.navigationEndpoint?.reelWatchEndpoint || urlPath.includes('/shorts/')) return null;

  const rawTitle = readYtText(v.title) || readYtText(v.headline);
  const channelName =
    readYtText(v.ownerText) || readYtText(v.shortBylineText) || readYtText(v.longBylineText);
  const durationSeconds = parseYouTubeDuration(readYtText(v.lengthText));

  if (!rawTitle || durationSeconds <= 0) return null;
  if (!isIndividualSong(rawTitle, channelName, durationSeconds)) return null;

  const { artist, title } = parseYouTubeArtistAndTitle(rawTitle, channelName);
  if (!isIndividualSong(title, artist, durationSeconds)) return null;

  const viewText =
    readYtText(v.viewCountText) ||
    readYtText(v.shortViewCountText) ||
    v.title?.accessibility?.accessibilityData?.label ||
    '';
  const viewCount = parseYouTubeViewCount(viewText);
  const isOfficial = isOfficialYouTubeUpload(v, channelName);

  seenIds.add(videoId);
  return {
    videoId,
    title,
    artist,
    durationSeconds,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    viewCount,
    isOfficial,
    channelName,
  };
}

interface YouTubeLockupVideoCard {
  contentId?: string;
  contentType?: string;
  metadata?: {
    lockupMetadataViewModel?: {
      title?: { content?: string };
      metadata?: {
        contentMetadataViewModel?: {
          metadataRows?: Array<{
            metadataParts?: Array<{
              text?: {
                content?: string;
                attachmentRuns?: Array<{
                  element?: {
                    type?: {
                      imageType?: {
                        image?: { sources?: Array<{ clientResource?: { imageName?: string } }> };
                      };
                    };
                  };
                }>;
              };
            }>;
          }>;
        };
      };
    };
  };
  contentImage?: {
    thumbnailViewModel?: {
      overlays?: Array<{
        thumbnailOverlayBadgeViewModel?: {
          thumbnailBadges?: Array<{
            thumbnailBadgeViewModel?: { text?: string };
          }>;
        };
        thumbnailBottomOverlayViewModel?: {
          badges?: Array<{
            thumbnailBadgeViewModel?: { text?: string };
          }>;
        };
      }>;
    };
  };
}

function extractVideoFromLockup(
  lk: YouTubeLockupVideoCard,
  seenIds: Set<string>
): ParsedYouTubeVideo | null {
  const videoId = lk?.contentId?.trim() || '';
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId) || seenIds.has(videoId)) return null;
  if (
    lk.contentType &&
    lk.contentType.includes('PLAYLIST') &&
    !lk.contentType.includes('VIDEO')
  ) {
    return null;
  }

  const rawTitle = lk.metadata?.lockupMetadataViewModel?.title?.content?.trim() || '';
  if (!rawTitle) return null;

  const rows =
    lk.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
  const channelName = rows[0]?.metadataParts?.[0]?.text?.content?.trim() || '';

  const badges = lk.contentImage?.thumbnailViewModel?.overlays || [];
  let durationText = '';
  for (const ov of badges) {
    const t =
      ov?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text ||
      ov?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text ||
      '';
    if (/^\d+(?::\d{1,2}){1,2}$/.test(t.trim())) {
      durationText = t.trim();
      break;
    }
  }
  const durationSeconds = parseYouTubeDuration(durationText);
  if (durationSeconds <= 0) return null;
  if (!isIndividualSong(rawTitle, channelName, durationSeconds)) return null;

  const { artist, title } = parseYouTubeArtistAndTitle(rawTitle, channelName);
  if (!isIndividualSong(title, artist, durationSeconds)) return null;

  let viewCount = 0;
  for (const row of rows) {
    for (const part of row.metadataParts || []) {
      const txt = part?.text?.content || '';
      const parsedViews = parseYouTubeViewCount(txt);
      if (parsedViews > 0) {
        viewCount = parsedViews;
        break;
      }
    }
    if (viewCount > 0) break;
  }

  const imageName =
    rows[0]?.metadataParts?.[0]?.text?.attachmentRuns?.[0]?.element?.type?.imageType?.image
      ?.sources?.[0]?.clientResource?.imageName || '';
  const hasVerifiedBadge = /CHECK|MUSIC|OFFICIAL/i.test(imageName);
  const isOfficial =
    hasVerifiedBadge || /-\s*Topic$/i.test(channelName) || /vevo$/i.test(channelName);

  seenIds.add(videoId);
  return {
    videoId,
    title,
    artist,
    durationSeconds,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    viewCount,
    isOfficial,
    channelName,
  };
}

export function extractYouTubeSearchResults(htmlOrJson: string): ParsedYouTubeVideo[] {
  const data = extractYtInitialDataJson(htmlOrJson);
  if (!data) return [];

  const renderers: YouTubeVideoRenderer[] = [];
  collectNodesByKey(data, 'videoRenderer', renderers as unknown[]);
  collectNodesByKey(data, 'videoWithContextRenderer', renderers as unknown[]);

  const seenIds = new Set<string>();
  const results: ParsedYouTubeVideo[] = [];

  for (const v of renderers) {
    const parsed = toParsedVideoFromRenderer(v, seenIds);
    if (parsed) results.push(parsed);
  }

  // Fallback / supplement: modern YouTube lockupViewModel cards
  const lockups: YouTubeLockupVideoCard[] = [];
  collectNodesByKey(data, 'lockupViewModel', lockups as unknown[]);
  for (const lk of lockups) {
    const parsed = extractVideoFromLockup(lk, seenIds);
    if (parsed) results.push(parsed);
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
  diffs += word.length - i + (target.length - j);
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
  const baseTerm =
    [cleanQ, genre ? `${genre} music` : ''].filter(Boolean).join(' ') || 'top music hits';

  switch (category) {
    case 'songs':
      return {
        // Keep query clean so YouTube's organic top hits & official Topic tracks surface instead of SEO spam reuploads
        searchQuery:
          [cleanQ, genre ? `${genre} music` : '', cleanQ ? '' : 'top hits songs']
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

export function buildInnertubeSearchBody(query: string, sp?: string): string {
  const payload: Record<string, unknown> = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20250218.01.00',
        hl: 'en',
        gl: 'US',
      },
    },
    query,
  };
  if (sp) {
    payload.params = decodeURIComponent(sp);
  }
  return JSON.stringify(payload);
}

export function rankYouTubeSearchResults(
  results: ParsedYouTubeVideo[],
  query: string,
  category: StreamSearchCategory = 'all'
): ParsedYouTubeVideo[] {
  const cleanQuery = query.trim().toLowerCase();
  const queryWantsDerivative =
    DERIVATIVE_UPLOAD_RE.test(cleanQuery) || VERSION_QUALIFIER_RE.test(cleanQuery);
  const queryTokens = cleanQuery.split(/[^a-z0-9]+/i).filter((t) => t.length >= 2);

  // Drop obvious unofficial derivative uploads unless user specifically asked for them
  const primaryPool = queryWantsDerivative
    ? results
    : results.filter(
        (r) => !DERIVATIVE_UPLOAD_RE.test(`${r.title} ${r.artist} ${r.channelName || ''}`)
      );

  const pool = primaryPool.length > 0 ? primaryPool : results;
  const hasHighAuthorityAnchor = pool.some(
    (r) => Boolean(r.isOfficial) || (r.viewCount || 0) >= 50_000
  );

  const scoreItem = (item: ParsedYouTubeVideo, index: number): number => {
    const cleanChannel = (item.channelName || '').replace(/\s*-\s*Topic$/i, '').toLowerCase();
    const titleLower = item.title.toLowerCase();
    const haystack = `${item.artist} ${item.title} ${item.channelName || ''}`.toLowerCase();
    const haystackWords = haystack.split(/[^a-z0-9]+/i).filter((w) => w.length >= 2);
    const channelWords = cleanChannel.split(/[^a-z0-9]+/i).filter((w) => w.length >= 2);
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
      if (cleanQuery.length >= 4 && haystack.includes(cleanQuery)) score += 18;

      // Extra credit when the official/channel name itself matches artist tokens in query
      if (channelWords.length > 0) {
        const channelMatched = queryTokens.some(
          (tok) => tok.length >= 3 && tokenMatchScore(tok, channelWords, cleanChannel) >= 0.85
        );
        if (channelMatched) score += 22;
      }
    }

    // 2. Strong Official Artist / VEVO / - Topic channel authority boost
    if (item.isOfficial) score += 46;
    if (/-\s*topic$/i.test(item.channelName || '')) {
      score += category === 'songs' ? 24 : category === 'all' ? 14 : 6;
    } else if (/vevo$/i.test(item.channelName || '')) {
      score += 18;
    }

    // 3. Strong View-Count Popularity Ranking so popular hit singles beat obscure uploads
    const views = item.viewCount || 0;
    if (views > 0) {
      score += Math.log10(views + 1) * 14;
      if (views >= 100_000_000) score += 42;
      else if (views >= 10_000_000) score += 32;
      else if (views >= 1_000_000) score += 22;
      else if (views >= 100_000) score += 12;
      else if (hasHighAuthorityAnchor && !item.isOfficial && views < 10_000) score -= 65;
    } else if (hasHighAuthorityAnchor && !item.isOfficial) {
      score -= 48;
    }

    // 4. Category-specific ranking adjustments
    if (category === 'videos' && /\b(official\s*(music\s*)?video|vevo)\b/i.test(haystack)) {
      score += 22;
    } else if (category === 'songs' && /-\s*topic$/i.test(item.channelName || '')) {
      score += 14;
    }

    // 5. Penalize unrequested remixes / covers / live / slowed / edits so original hit song comes #1
    if (!queryWantsDerivative) {
      if (VERSION_QUALIFIER_RE.test(titleLower) || VERSION_QUALIFIER_RE.test(cleanChannel)) {
        score -= 68;
      } else if (item.isOfficial) {
        score += 14;
      }
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

export function filterMusicSuggestions(suggestions: string[], userQuery = ''): string[] {
  const cleanQ = userQuery.trim().toLowerCase();
  const userAskedDerivative =
    DERIVATIVE_UPLOAD_RE.test(cleanQ) || VERSION_QUALIFIER_RE.test(cleanQ);
  const seen = new Set<string>();
  const filtered: string[] = [];

  for (const raw of suggestions) {
    const clean = raw.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    if (!userAskedDerivative && JUNK_SUGGESTION_RE.test(key)) continue;
    seen.add(key);
    filtered.push(clean);
  }

  return filtered.slice(0, 7);
}

export function filterRelevantAudiusTracks(tracks: Track[], query: string): Track[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return tracks;

  const matched = tracks.filter((t) => {
    const hay = `${t.artist} ${t.title}`.toLowerCase();
    const hayWords = hay.split(/[^a-z0-9]+/i).filter((w) => w.length >= 2);
    const hits = tokens.filter((tok) => tokenMatchScore(tok, hayWords, hay) >= 0.85).length;
    return hits >= Math.min(tokens.length, 2) || (tokens.length === 1 && hits === 1);
  });

  return matched;
}

export function parseYouTubeSuggestResponse(rawText: string, userQuery = ''): string[] {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
      const items = parsed[1].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0
      );
      return filterMusicSuggestions(items, userQuery);
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
      isOfficial: isOfficialYouTubeUpload(v, channelName),
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

  // Fallback: synthesize artist cards from verified / - Topic / VEVO uploaders when channelRenderer is absent
  if (out.length === 0) {
    const videos: YouTubeVideoRenderer[] = [];
    collectNodesByKey(data, 'videoRenderer', videos as unknown[]);
    collectNodesByKey(data, 'videoWithContextRenderer', videos as unknown[]);
    for (const v of videos) {
      const channelRaw =
        readYtText(v.ownerText) || readYtText(v.shortBylineText) || readYtText(v.longBylineText);
      const isOff = isOfficialYouTubeUpload(v, channelRaw);
      if (!isOff || !channelRaw) continue;
      const name = channelRaw.replace(/\s*-\s*Topic$/i, '').replace(/vevo$/i, '').trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `artist-${key}`,
        name,
        thumbnailUrl: v.videoId ? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg` : undefined,
        subscriberText: 'Official Artist',
        isOfficial: true,
      });
      if (out.length >= 6) break;
    }
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
        isOfficial: isOfficialYouTubeUpload(v, channelName),
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
      isOfficial: isOfficialYouTubeUpload(v, channelName),
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

export function clampCrossfadeSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 2.5;
  const clamped = Math.max(0, Math.min(12, seconds));
  return Math.round(clamped * 10) / 10;
}

export function reorderQueueItems<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Enqueue a batch of uploaded/imported offline songs so all tracks automatically play in sequence
 * rather than leaving only the first track in the queue.
 */
export function enqueueImportedOfflineTracks(
  existingQueue: Track[],
  importedTracks: Track[],
  stemIds: Set<string>
): Track[] {
  if (importedTracks.length === 0) return existingQueue;

  const dedupedImports: Track[] = [];
  const importedIds = new Set<string>();
  for (const t of importedTracks) {
    if (!importedIds.has(t.id)) {
      importedIds.add(t.id);
      dedupedImports.push(t);
    }
  }

  const onlyDefaultStems = existingQueue.every((t) => stemIds.has(t.id));
  if (onlyDefaultStems) {
    return dedupedImports;
  }

  const preserved = existingQueue.filter((t) => !stemIds.has(t.id) && !importedIds.has(t.id));
  return [...preserved, ...dedupedImports];
}

export function buildCollectionQueue(
  collectionTracks: Track[],
  startIndex = 0
): { queue: Track[]; startTrack: Track | null } {
  const seen = new Set<string>();
  const deduped: Track[] = [];
  for (const t of collectionTracks) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      deduped.push(t);
    }
  }
  if (deduped.length === 0) {
    return { queue: [], startTrack: null };
  }
  const target = collectionTracks[startIndex];
  const resolvedIdx = target ? deduped.findIndex((t) => t.id === target.id) : 0;
  const safeIdx = resolvedIdx >= 0 ? resolvedIdx : 0;
  return {
    queue: deduped,
    startTrack: deduped[safeIdx] ?? deduped[0],
  };
}


