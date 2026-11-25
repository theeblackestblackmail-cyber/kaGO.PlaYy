import type {
  ActiveTab,
  EqPresetName,
  LibrarySubTab,
  Track,
} from '../types/audio';
import {
  buildAiTrackSearchQuery,
  type AiAssistantAction,
  type AiAssistantContextPayload,
  type AiAssistantSource,
} from './aiAssistant';
import { formatDuration } from './lrcParser';
import { hasNativeHttpBridge, nativeFetchText } from './nativeMediaBridge';
import { canonicalSongKey } from './streamDiscovery';
import type { DownloadFormatId } from './streamDownloads';
import { isIndividualSong } from './streamFilter';
import { searchStreamsUnified } from './streamSearch';

export type PendingSiriAction =
  | {
      kind: 'tracks';
      tracks: Track[];
      label?: string;
    }
  | {
      kind: 'playlist';
      name: string;
      description: string;
      tracks: Track[];
    };

export interface SiriTurnResult {
  reply: string;
  actions: AiAssistantAction[];
  awaitingConfirmTracks?: Track[];
  resolvedTracks?: Track[];
  createdPlaylist?: {
    name: string;
    description: string;
    tracks: Track[];
    autoPlay?: boolean;
  };
  nextPending?: PendingSiriAction | null;
  clearPending?: boolean;
  sources?: AiAssistantSource[];
}

export interface PendingConfirmationMatch {
  decision: 'confirm' | 'cancel';
  selectedIndex: number;
  playMode: 'play_now' | 'play_next' | 'add_to_queue';
}

const VALID_EQ_NAMES: EqPresetName[] = [
  'Flat',
  'Bass',
  'Heavy Bass',
  'Rock',
  'Pop',
  'Classical',
  'Jazz',
  'Electronic',
  'Hip-Hop',
  'Vocal Boost',
  'Acoustic',
  'Treble Boost',
];

export function mergeDictatedPrompt(baseText: string, dictatedText: string): string {
  const base = (baseText || '').trim();
  const spoken = (dictatedText || '').replace(/\s+/g, ' ').trim();
  if (!spoken) return base;
  if (!base) return spoken;
  return `${base} ${spoken}`;
}

function formatCompactCount(count?: number): string {
  if (!count || !Number.isFinite(count) || count <= 0) return '';
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B views`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M views`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K views`;
  return `${Math.round(count)} views`;
}

export function formatTrackSummaryLine(track: Track): string {
  const parts: string[] = [];
  if (track.duration > 0) {
    parts.push(formatDuration(track.duration));
  }
  const views = formatCompactCount(track.viewCount);
  if (views) {
    parts.push(views);
  }
  const suffix = parts.length > 0 ? ` (${parts.join(' · ')})` : '';
  return `"${track.title}" by ${track.artist}${suffix}`;
}

export function matchPendingConfirmation(
  rawPrompt: string,
  pending: PendingSiriAction | null
): PendingConfirmationMatch | null {
  if (!pending) return null;
  const text = rawPrompt.trim().toLowerCase();
  if (!text) return null;

  // Reject clearly unrelated new commands so the user is never trapped in confirmation
  if (
    /^(?:pause|stop\s+music|skip|next\s+track|previous|rewind|forward|open\s+|go\s+to\s+|create\s+(?:me\s+)?(?:a\s+|an\s+)?(?:custom\s+)?playlist|where\s+was|who\s+|what\s+song\s+is\s+playing|search\s+for|look\s+for)\b/i.test(
      text
    ) ||
    /\b(?:create|make|build|generate)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:[a-z]+\s+){0,3}?playlist\b/i.test(
      text
    )
  ) {
    return null;
  }

  // Cancellations
  if (
    /^(?:no|nope|nah|cancel|never\s*mind|nevermind|don'?t|not\s+that|wrong\s*(?:one|song)?|stop)\b/i.test(
      text
    )
  ) {
    return { decision: 'cancel', selectedIndex: 0, playMode: 'play_now' };
  }

  // Ordinal selection ("second one", "2nd", "number 2", "option 3")
  let selectedIndex = 0;
  let hasOrdinal = false;
  if (/\b(?:second|2nd|number\s*2|option\s*2|track\s*2|#2)\b/i.test(text)) {
    selectedIndex = 1;
    hasOrdinal = true;
  } else if (/\b(?:third|3rd|number\s*3|option\s*3|track\s*3|#3)\b/i.test(text)) {
    selectedIndex = 2;
    hasOrdinal = true;
  } else if (/\b(?:first|1st|number\s*1|option\s*1|track\s*1|#1)\b/i.test(text)) {
    selectedIndex = 0;
    hasOrdinal = true;
  }

  const maxIdx = Math.max(0, pending.tracks.length - 1);
  if (selectedIndex > maxIdx) selectedIndex = 0;

  let playMode: PendingConfirmationMatch['playMode'] = 'play_now';
  let hasQueueVerb = false;
  if (/\b(?:play\s+next|next\s+up|up\s+next)\b|\bplay\b.*\bnext\b/i.test(text)) {
    playMode = 'play_next';
    hasQueueVerb = true;
  } else if (/\b(?:queue|add\s+to\s+queue)\b/i.test(text)) {
    playMode = 'add_to_queue';
    hasQueueVerb = true;
  }

  const isAffirmative =
    /^(?:yes|yeah|yep|yup|sure|ok|okay|please|confirm|go\s+ahead|do\s+it|sawa|ndio|play(?:\s+it|\s+that|\s+now|\s+this)?|hit\s+it|run\s+it|let'?s\s+go)(?:\s+please)?[.!]?$/i.test(
      text
    ) ||
    /^(?:yes|yeah|yep|yup|sure|ok|okay)(?:[,\s]+please)?[,\s]+(?:play|queue|do|go|confirm)/i.test(
      text
    );

  if (isAffirmative || hasOrdinal || hasQueueVerb) {
    return {
      decision: 'confirm',
      selectedIndex,
      playMode,
    };
  }

  return null;
}

export function extractSongSearchQuery(rawPrompt: string): {
  query: string;
  wantsMix: boolean;
  wantsVideo: boolean;
  wantsOffline: boolean;
  requestedMode: 'ask_confirm' | 'play_next' | 'add_to_queue';
} {
  const original = rawPrompt.trim();
  const lower = original.toLowerCase();

  const wantsMix =
    /\b(?:mix|dj\s+mix|dj\s+set|mixtape|mashup|megamix|nonstop|non-stop|1\s*hour|2\s*hour)\b/i.test(
      lower
    );
  const wantsVideo =
    /\b(?:music\s+video|video|podcast|interview|live\s+performance|documentary|vlog|tutorial)\b/i.test(
      lower
    );
  const wantsOffline =
    /\b(?:offline|in\s+my\s+library|my\s+library|downloaded|saved\s+song|local\s+song)\b/i.test(
      lower
    );

  let requestedMode: 'ask_confirm' | 'play_next' | 'add_to_queue' = 'ask_confirm';
  if (/\bplay\s+(?:this\s+|that\s+)?next\b|\bplay\s+.+\s+next(?:\s+please)?$|\bplay\s+next\b/i.test(lower)) {
    requestedMode = 'play_next';
  } else if (/\b(?:add\s+.+\s+to\s+(?:the\s+)?queue|queue\s+(?:up\s+)?)\b/i.test(lower)) {
    requestedMode = 'add_to_queue';
  }

  // Strip polite & transport preamble so only descriptive content remains
  let working = original
    .replace(/^(?:hey\s+(?:siri|ai|kago)|ok\s+kago|please|can\s+you|could\s+you|would\s+you|i\s+want\s+(?:you\s+)?to|help\s+me)\s+/gi, '')
    .replace(/^(?:please|can\s+you|could\s+you|would\s+you)\s+/gi, '')
    .replace(/^(?:find\s+and\s+play|search\s+for\s+and\s+play|look\s+for\s+and\s+play|play\s+next|add\s+to\s+queue|queue\s+up|queue|find\s+me|find|search\s+for|search|look\s+for|look\s+up|play\s+me|play|stream)\s+/i, '')
    .replace(/^(?:there\s+is\s+|i\s+think\s+there'?s\s+|this\s+is\s+)/i, '')
    .replace(/\b(?:on|from|via|using)\s+(?:youtube|audius|the\s+app|kago(?:\s*play)?)\b/gi, ' ')
    .replace(/\b(?:for\s+me|right\s+now|please|in\s+the\s+app)\b/gi, ' ')
    .replace(/\bplay\s+next\b|\badd\s+to\s+queue\b|\s+next$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Pattern 1: "... by <artist> called/named/titled <title>"
  // e.g. "a kenyan popular song by wakadinali called blow" -> "wakadinali blow"
  const byArtistCalledTitle = working.match(
    /\bby\s+(.+?)\s+(?:called|named|titled)\s+["“']?([^"”']+)["”']?$/i
  );
  if (byArtistCalledTitle) {
    const artistPart = byArtistCalledTitle[1].replace(/\b(?:a|an|the)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const titlePart = byArtistCalledTitle[2].trim();
    const joined = `${artistPart} ${titlePart}`.replace(/\s+/g, ' ').trim();
    if (joined) {
      return {
        query: wantsMix && !/\bmix\b/i.test(joined) ? `${joined} mix` : joined,
        wantsMix,
        wantsVideo,
        wantsOffline,
        requestedMode,
      };
    }
  }

  // Pattern 2: "... called/named/titled <title> by <artist>"
  const calledTitleByArtist = working.match(
    /(?:called|named|titled)\s+["“']?(.+?)["”']?\s+by\s+(.+)$/i
  );
  if (calledTitleByArtist) {
    const titlePart = calledTitleByArtist[1].trim();
    const artistPart = calledTitleByArtist[2].trim();
    const joined = `${artistPart} ${titlePart}`.replace(/\s+/g, ' ').trim();
    if (joined) {
      return {
        query: wantsMix && !/\bmix\b/i.test(joined) ? `${joined} mix` : joined,
        wantsMix,
        wantsVideo,
        wantsOffline,
        requestedMode,
      };
    }
  }

  // Pattern 3: Quoted title + optional artist
  const quoted = working.match(/["“']([^"”']{2,})["”']/);
  if (quoted) {
    const afterBy = working.match(/\bby\s+([a-z0-9\s.&'-]{2,50})/i);
    const titlePart = quoted[1].trim();
    const artistPart = afterBy ? afterBy[1].replace(/\b(?:called|named|titled)\b.*$/i, '').trim() : '';
    const joined = [artistPart, titlePart].filter(Boolean).join(' ').trim();
    if (joined) {
      return {
        query: joined,
        wantsMix,
        wantsVideo,
        wantsOffline,
        requestedMode,
      };
    }
  }

  // Generic cleanup of conversational filler words while preserving artist/title/genre/mix descriptors
  let cleaned = working
    .replace(/\b(?:a|an|some|certain|popular|famous|hit|nice|cool|trending|offline|saved|local)\b/gi, ' ')
    .replace(/\b(?:songs?|tracks?|tunes?|singles?)\b(?=\s+(?:by|called|named|titled|from|of)\b|\s*$)/gi, ' ')
    .replace(/\b(?:called|named|titled)\b/gi, ' ')
    .replace(/\bby\s+/gi, ' ')
    .replace(/\b(?:in\s+my\s+library|my\s+library|downloaded)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Preserve leading region/style keywords if that's the entire query (e.g. "kenyan hip hop mix")
  if (!cleaned) {
    cleaned = working.trim() || original;
  }

  if (wantsMix && !/\b(?:mix|mixtape|set|mashup)\b/i.test(cleaned)) {
    cleaned = `${cleaned} mix`.trim();
  }

  return {
    query: cleaned,
    wantsMix,
    wantsVideo,
    wantsOffline,
    requestedMode,
  };
}

export function extractDspDirective(rawPrompt: string): Extract<AiAssistantAction, { type: 'update_dsp' }> | null {
  const lower = rawPrompt.trim().toLowerCase();
  if (!lower) return null;

  let eqPreset: EqPresetName | undefined;
  let bassBoostEnabled: boolean | undefined;
  let bassBoostDb: number | undefined;
  let crossfadeSeconds: number | undefined;

  // Match EQ preset names (longest match first so "Heavy Bass" beats "Bass")
  const sortedPresets = [...VALID_EQ_NAMES].sort((a, b) => b.length - a.length);
  for (const preset of sortedPresets) {
    const needle = preset.toLowerCase();
    if (
      lower.includes(`${needle} eq`) ||
      lower.includes(`${needle} preset`) ||
      lower.includes(`${needle} mode`) ||
      (lower.includes(needle) && /\b(?:eq|equalizer|preset|set|switch|turn|put|audio|sound)\b/.test(lower))
    ) {
      eqPreset = preset;
      break;
    }
  }

  if (/\bbass\s*boost\b|\bmore\s+bass\b|\bheavy\s+bass\b|\bboost\s+(?:the\s+)?bass\b|\bextra\s+bass\b/i.test(lower)) {
    if (/\b(?:off|disable|turn\s+off|stop|zero)\b/i.test(lower)) {
      bassBoostEnabled = false;
      bassBoostDb = 0;
    } else {
      bassBoostEnabled = true;
      const dbMatch = lower.match(/(\d+(?:\.\d+)?)\s*db\b/);
      if (dbMatch) {
        bassBoostDb = Math.max(0, Math.min(14, Math.round(Number(dbMatch[1]))));
      } else {
        bassBoostDb = 8;
      }
    }
  }

  const cfMatch = lower.match(/crossfade(?:\s+to|\s+at)?\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?/i);
  if (cfMatch) {
    crossfadeSeconds = Math.max(0, Math.min(12, Math.round(Number(cfMatch[1]) * 2) / 2));
  } else if (/\b(?:disable|turn\s+off|no)\s+crossfade\b/i.test(lower)) {
    crossfadeSeconds = 0;
  }

  if (
    eqPreset === undefined &&
    bassBoostEnabled === undefined &&
    bassBoostDb === undefined &&
    crossfadeSeconds === undefined
  ) {
    return null;
  }

  return {
    type: 'update_dsp',
    eqPreset,
    bassBoostEnabled,
    bassBoostDb,
    crossfadeSeconds,
  };
}

export interface PlaylistDirective {
  name: string;
  topicQuery: string;
  requestedCount: number;
  explicitCount: boolean;
  autoPlay: boolean;
  wantsPopular: boolean;
  wantsMixPlaylist: boolean;
  isCustom: boolean;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
};

const PLAYLIST_JUNK_RE =
  /\b(full\s*album|full\s*mix|dj\s*mix|dj\s*set|megamix|nonstop|non-stop|compilation|1\s*hour|2\s*hours|continuous\s*mix|podcast|type\s*beat|karaoke|slowed|reverb|sped\s*up|speed\s*up|nightcore|8d\s*audio|reaction|tutorial|interview)\b/i;

function parseWordOrDigitCount(token: string): number | null {
  const clean = token.trim().toLowerCase();
  if (!clean) return null;
  if (/^\d{1,3}$/.test(clean)) {
    const n = parseInt(clean, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const compound = clean.match(/^(twenty)[\s-]+(one|two|three|four|five|six|seven|eight|nine)$/);
  if (compound) {
    return 20 + (NUMBER_WORDS[compound[2]] || 0);
  }
  return NUMBER_WORDS[clean] ?? null;
}

export function extractRequestedTrackCount(rawText: string): {
  count: number;
  explicit: boolean;
  cleanedText: string;
} {
  const text = rawText.trim();
  const numWordAlt =
    '(?:twenty[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine)|thirty|twenty|nineteen|eighteen|seventeen|sixteen|fifteen|fourteen|thirteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|\\d{1,2})';

  // Pattern A: "top 20" / "best twenty"
  const topPattern = new RegExp(`\\b(?:top|best)\\s+(${numWordAlt})\\b`, 'i');
  const topMatch = text.match(topPattern);
  if (topMatch && typeof topMatch.index === 'number') {
    const parsed = parseWordOrDigitCount(topMatch[1]);
    if (parsed !== null && parsed >= 2 && parsed <= 50) {
      const clamped = Math.max(3, Math.min(30, parsed));
      const before = text.slice(0, topMatch.index);
      const after = text.slice(topMatch.index + topMatch[0].length);
      return {
        count: clamped,
        explicit: true,
        cleanedText: `${before} ${after}`.replace(/\s+/g, ' ').trim(),
      };
    }
  }

  // Pattern B: "<count> [popular/best/drake/...] songs/tracks/hits"
  // Guard numeric artist names like "21 savage", "50 cent", "3 doors down", "30 seconds to mars"
  const guardedText = text
    .replace(/\b21\s+savage\b/gi, '__ARTIST_21_SAVAGE__')
    .replace(/\b50\s+cent\b/gi, '__ARTIST_50_CENT__')
    .replace(/\b30\s+seconds\s+to\s+mars\b/gi, '__ARTIST_30_SECONDS__')
    .replace(/\b3\s+doors\s+down\b/gi, '__ARTIST_3_DOORS__');

  const adjWord =
    '(?:popular|top|best|good|great|favorite|favourite|famous|trending|hit|classic|essential|random|different|distinct|new|old|recent|most\\s+played|greatest|hot|chill|custom)';
  const mediaWord = '(?:songs?|tracks?|tunes?|singles?|bangers?|hits?|mixes?|videos?)';

  const countPattern = new RegExp(
    `\\b(${numWordAlt})\\b(?=\\s+(?:${adjWord}\\s+)*(?:(?:[a-z0-9&'._-]+\\s+){0,2})${mediaWord}\\b|\\s+${adjWord}\\b)`,
    'i'
  );
  const countMatch = guardedText.match(countPattern);
  if (countMatch && typeof countMatch.index === 'number') {
    const parsed = parseWordOrDigitCount(countMatch[1]);
    if (parsed !== null && parsed >= 2 && parsed <= 50) {
      const clamped = Math.max(3, Math.min(30, parsed));
      const before = guardedText.slice(0, countMatch.index);
      const after = guardedText.slice(countMatch.index + countMatch[0].length);
      const restored = `${before} ${after}`
        .replace(/__ARTIST_21_SAVAGE__/g, '21 Savage')
        .replace(/__ARTIST_50_CENT__/g, '50 Cent')
        .replace(/__ARTIST_30_SECONDS__/g, '30 Seconds to Mars')
        .replace(/__ARTIST_3_DOORS__/g, '3 Doors Down')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        count: clamped,
        explicit: true,
        cleanedText: restored,
      };
    }
  }

  return {
    count: 12,
    explicit: false,
    cleanedText: text,
  };
}

function toTitleCaseLabel(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function cleanPlaylistTopic(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:hey\s+(?:siri|ai|kago)|ok\s+kago|please|can\s+you|could\s+you|would\s+you|help\s+me|i\s+want\s+(?:you\s+)?to)\s+/gi, '')
    .replace(/^(?:look\s+for|search\s+for|search|find\s+me|find|get\s+me|get|pull\s+up|gather|collect|give\s+me|compile|curate|make|create|build|generate)\s+/gi, '')
    .replace(/\b(?:and\s+play(?:\s+it)?|play\s+it|start\s+playing|for\s+me|please|in\s+the\s+app)\b/gi, ' ')
    .replace(/\b(?:custom|personal|personalized|new|playlist)\b/gi, ' ')
    .replace(/\b(?:popular|famous|trending|most\s+played)\b/gi, ' ')
    .replace(/\b(?:songs?|tracks?|tunes?|singles?|bangers?|music)\b/gi, ' ')
    .replace(/\s+\b(?:with|from|featuring|about)\b\s+/gi, ' ')
    .trim()
    .replace(/^(?:(?:me|of|for|with|about|featuring|from|by|on|the|a|an)\s+)+/gi, '')
    .replace(/\s+\b(?:by|of|for)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePlaylistDirective(rawPrompt: string): PlaylistDirective | null {
  const original = rawPrompt.trim();
  if (!original) return null;
  if (!/\bplaylists?\b/i.test(original)) return null;

  // Do not hijack simple navigation commands like "open my playlists" or "go to playlists"
  if (
    /^(?:open|show|go\s+to|switch\s+to|view)\s+(?:my\s+|the\s+)?playlists?$/i.test(original)
  ) {
    return null;
  }

  let preTopic = '';
  let postTopic = '';
  let explicitName = '';

  // Case 1: "<search/find topic> [and] create/make/build [a custom] playlist [called X] [and play it]"
  const beforeThenCreate = original.match(
    /^(.+?)\s+(?:(?:\b(?:and|n|&|then|to)\b|,)\s*)?(?:please\s+)?(?:create|make|build|generate|curate|compile|turn\s+(?:them|those|it)\s+into|put\s+(?:them|those|it)\s+in(?:to)?|save\s+(?:them|those|it)\s+(?:as|in(?:to)?))\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:[a-z]+\s+){0,3}?playlists?\b(.*)$/i
  );

  // Case 2: "create/make/build [me] [a/an] [descriptors] playlist [for/of/called ...]"
  const createMatch = original.match(
    /(?:create|make|build|generate|curate|compile|start|give\s+me)\s+(?:me\s+)?(?:a|an|my|the)?\s*(.*?)\bplaylists?\b(.*)$/i
  );

  // Case 3: "playlist of/for/with ..."
  const directPlaylistMatch = original.match(
    /^playlists?\s+(?:for|of|with|about|featuring|called|named)\s+(.+)$/i
  );

  if (beforeThenCreate) {
    preTopic = beforeThenCreate[1].trim();
    postTopic = beforeThenCreate[2].trim();
  } else if (createMatch) {
    preTopic = createMatch[1].trim();
    postTopic = createMatch[2].trim();
  } else if (directPlaylistMatch) {
    postTopic = directPlaylistMatch[1].trim();
  } else {
    return null;
  }

  const autoPlay = /\band\s+play\b|\bplay\s+it\b|\bstart\s+playing\b/i.test(original);
  const wantsPopular = /\b(?:popular|top|best|hits?|greatest|famous|trending)\b/i.test(original);
  const wantsMixPlaylist = /\b(?:dj\s+mix|mixes|nonstop|non-stop)\b/i.test(original);
  const isCustom = /\bcustom\b/i.test(original);

  // Extract explicit playlist name ("called X" / "named X" / "titled X") if present
  const namedMatch = postTopic.match(
    /\b(?:called|named|titled)\s+["“']?([^"”']+?)["”']?(?=\s+(?:of|for|with|featuring|about|and\s+play)\b|$)/i
  );
  if (namedMatch) {
    explicitName = namedMatch[1].trim();
    postTopic = postTopic.replace(namedMatch[0], ' ').trim();
  }

  const combinedRaw = [preTopic, postTopic].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const countInfo = extractRequestedTrackCount(combinedRaw);
  let topic = cleanPlaylistTopic(countInfo.cleanedText);

  if (!topic && explicitName) {
    topic = cleanPlaylistTopic(explicitName) || explicitName;
  }
  if (!topic) return null;

  const titleCase = toTitleCaseLabel(topic);
  let defaultName: string;
  if (explicitName) {
    defaultName = toTitleCaseLabel(explicitName).slice(0, 48).trim();
  } else if (countInfo.explicit && wantsPopular) {
    defaultName = (/\bhits$/i.test(titleCase)
      ? `Top ${countInfo.count} ${titleCase}`
      : `Top ${countInfo.count} ${titleCase} Hits`
    )
      .slice(0, 48)
      .trim();
  } else if (countInfo.explicit) {
    defaultName = `${titleCase} (${countInfo.count})`.slice(0, 48).trim();
  } else {
    defaultName = titleCase.length > 48 ? titleCase.slice(0, 48).trim() : `${titleCase} Mix`;
  }

  return {
    name: defaultName,
    topicQuery: topic,
    requestedCount: countInfo.count,
    explicitCount: countInfo.explicit,
    autoPlay,
    wantsPopular,
    wantsMixPlaylist,
    isCustom,
  };
}

export function extractPlaylistDirective(rawPrompt: string): {
  name: string;
  topicQuery: string;
  autoPlay: boolean;
} | null {
  const parsed = parsePlaylistDirective(rawPrompt);
  if (!parsed) return null;
  return {
    name: parsed.name,
    topicQuery: parsed.topicQuery,
    autoPlay: parsed.autoPlay,
  };
}

export function extractLyricsSnippet(rawPrompt: string): string | null {
  const original = rawPrompt.trim();

  // "Find song by lyrics: ..."
  const explicitPrefix = original.match(
    /^(?:find\s+(?:the\s+)?song\s+by\s+lyrics?|lyrics?\s+search|identify\s+lyrics?|search\s+lyrics?)[:\s-]+(.+)$/i
  );
  if (explicitPrefix && explicitPrefix[1].trim().length >= 4) {
    return explicitPrefix[1].trim().replace(/^["“']|["”']$/g, '');
  }

  // "what song goes '...' " / "song that says ..."
  const phraseMatch = original.match(
    /(?:what|which)\s+song\s+(?:goes|sings|says|has\s+the\s+lyrics?)\s+["“']?(.+?)["”']?\??$/i
  );
  if (phraseMatch && phraseMatch[1].trim().length >= 4) {
    return phraseMatch[1].trim();
  }

  // Multi-word quoted lyrics with lyrics context
  if (/\blyrics?\b/i.test(original)) {
    const quoted = original.match(/["“']([^"”']{4,})["”']/);
    if (quoted) return quoted[1].trim();
  }

  return null;
}

export function isMusicKnowledgeQuestion(rawPrompt: string): boolean {
  const lower = rawPrompt.trim().toLowerCase();
  return (
    /\b(?:sampled\s+from|sample\s+of|samples\s+what|what\s+song\s+(?:does|is)\s+.+\s+sample|who\s+sampled)\b/i.test(
      lower
    ) ||
    /\b(?:who\s+(?:produced|made|wrote|sang|featured\s+on)|what\s+album\s+is|when\s+was\s+.+\s+released|what\s+song\s+is\s+(?:this|playing)|what\s+is\s+playing|tell\s+me\s+about\s+(?:this|the)\s+song|meaning\s+of)\b/i.test(
      lower
    ) ||
    /^where\s+was\b/i.test(lower)
  );
}

export function extractAppControlAction(
  rawPrompt: string
): AiAssistantAction | null {
  const text = rawPrompt.trim();
  const lower = text.toLowerCase();

  // Direct transport controls
  if (/^(?:pause|pause\s+(?:the\s+)?(?:song|track|music|playback)|stop\s+(?:the\s+)?(?:music|playback))$/i.test(lower)) {
    return { type: 'control_playback', command: 'pause' };
  }
  if (/^(?:play|resume|unpause|continue\s+(?:playing|music|playback)|start\s+playback)$/i.test(lower)) {
    return { type: 'control_playback', command: 'play' };
  }
  if (/^(?:toggle\s+play(?:back)?|play\s*\/?\s*pause)$/i.test(lower)) {
    return { type: 'control_playback', command: 'toggle' };
  }
  if (/^(?:skip|next|next\s+(?:song|track)|skip\s+(?:this\s+)?(?:song|track))$/i.test(lower)) {
    return { type: 'control_playback', command: 'next' };
  }
  if (/^(?:prev|previous|previous\s+(?:song|track)|last\s+(?:song|track)|go\s+back\s+(?:a\s+)?(?:song|track))$/i.test(lower)) {
    return { type: 'control_playback', command: 'previous' };
  }

  // Seek relative ("rewind 15 seconds", "forward 30s", "skip ahead 1 minute")
  const seekForward = lower.match(
    /^(?:fast\s+)?(?:forward|skip\s+ahead|jump\s+ahead|seek\s+forward)\s+(?:by\s+)?(\d+)\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?)?$/i
  );
  if (seekForward) {
    const raw = Number(seekForward[1]);
    const isMin = /\b(?:m|min|mins|minutes?)\b/i.test(lower);
    return {
      type: 'control_playback',
      command: 'seek_relative',
      valueSeconds: Math.min(600, raw * (isMin ? 60 : 1)),
    };
  }
  const seekBack = lower.match(
    /^(?:rewind|go\s+back|skip\s+back|seek\s+back)\s+(?:by\s+)?(\d+)\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?)?$/i
  );
  if (seekBack) {
    const raw = Number(seekBack[1]);
    const isMin = /\b(?:m|min|mins|minutes?)\b/i.test(lower);
    return {
      type: 'control_playback',
      command: 'seek_relative',
      valueSeconds: -Math.min(600, raw * (isMin ? 60 : 1)),
    };
  }

  if (/\b(?:toggle\s+shuffle|turn\s+(?:on|off)\s+shuffle|shuffle\s+(?:on|off)|shuffle\s+queue)\b/i.test(lower)) {
    return { type: 'control_playback', command: 'toggle_shuffle' };
  }
  if (/\b(?:toggle\s+(?:autoplay\s+)?radio|start\s+radio|turn\s+(?:on|off)\s+(?:autoplay|radio))\b/i.test(lower)) {
    return { type: 'control_playback', command: 'toggle_autoplay_radio' };
  }
  if (/\b(?:open|show|expand)\s+(?:the\s+)?(?:full\s*screen|fullscreen|now\s+playing|player)\b/i.test(lower)) {
    return { type: 'control_playback', command: 'open_fullscreen' };
  }
  if (/\b(?:open|show|view)\s+(?:the\s+)?(?:sync(?:ed)?\s+)?lyrics?\b/i.test(lower)) {
    return { type: 'control_playback', command: 'open_lyrics' };
  }
  if (/\b(?:open|show)\s+(?:the\s+)?(?:eq|equalizer|dsp(?:\s+studio)?|sound\s+settings|audio\s+studio)\b/i.test(lower)) {
    return { type: 'control_playback', command: 'open_dsp' };
  }
  if (/\b(?:open|start|join|launch)\s+(?:the\s+)?(?:shared\s+)?live\s+studio\b/i.test(lower)) {
    return { type: 'control_playback', command: 'open_live_studio' };
  }
  if (/\b(?:pick|upload|import|add)\s+(?:a\s+)?(?:local\s+)?(?:song|songs|audio\s+file)\b/i.test(lower)) {
    return { type: 'control_playback', command: 'pick_song' };
  }
  if (/\b(?:pick|upload|import|add)\s+(?:a\s+)?(?:music\s+)?folder\b/i.test(lower)) {
    return { type: 'control_playback', command: 'pick_folder' };
  }

  // Favorite current track
  if (/^(?:favorite|like|love|save\s+to\s+favorites)\s+(?:this(?:\s+song)?|current\s+(?:song|track)|it)$/i.test(lower) || /^(?:favorite\s+this|like\s+this\s+song|add\s+(?:this\s+)?to\s+favorites)$/i.test(lower)) {
    return { type: 'toggle_favorite_current', favorite: true };
  }
  if (/^(?:unfavorite|unlike|remove\s+(?:this\s+)?from\s+favorites)$/i.test(lower)) {
    return { type: 'toggle_favorite_current', favorite: false };
  }

  // Download current track
  if (/\bdownload\s+(?:this(?:\s+song|\s+track)?|current\s+(?:song|track))\b|\bsave\s+(?:this(?:\s+song|\s+track)?)\s+(?:offline|for\s+offline|in\s+app)\b/i.test(lower)) {
    const wantsVideo = /\b(?:video|mp4|720p|480p|360p)\b/i.test(lower);
    const wantsDevice =
      wantsVideo ||
      /\b(?:mp3|m4a|locally|to\s+(?:device|phone|storage|downloads?\s+folder))\b/i.test(lower);
    let formatId: DownloadFormatId = 'mp3-160';
    if (/\bmp4\b|\b720p?\b|\bvideo\b/.test(lower)) formatId = 'mp4-720p';
    else if (/\b480p?\b/.test(lower)) formatId = 'mp4-480p';
    else if (/\b360p?\b/.test(lower)) formatId = 'mp4-360p';
    else if (/\b240p?\b/.test(lower)) formatId = 'mp4-240p';
    else if (/\b144p?\b/.test(lower)) formatId = 'mp4-144p';
    else if (/\b320\b|\bhigh\s+quality\b/.test(lower)) formatId = 'mp3-320';
    else if (/\b128\b/.test(lower)) formatId = 'mp3-128';
    else if (/\b70\b/.test(lower)) formatId = 'mp3-70';
    else if (/\bm4a\b/.test(lower)) formatId = 'm4a-128';

    return {
      type: 'download_current_track',
      destination: wantsDevice ? 'device' : 'app',
      formatId: wantsDevice ? formatId : undefined,
    };
  }

  // Tab navigation
  const navMatch = lower.match(
    /^(?:open|go\s+to|show|switch\s+to)\s+(?:my\s+|the\s+)?(dashboard|home|stream|discover|library|settings|theme(?:\s+settings)?|search|scanner|album\s+scanner|playlists?|favorites?|downloads?|albums?|artists?|folders?)$/i
  );
  if (navMatch) {
    const target = navMatch[1].toLowerCase();
    const subTabMap: Record<string, LibrarySubTab> = {
      playlist: 'playlists',
      playlists: 'playlists',
      favorite: 'favorites',
      favorites: 'favorites',
      download: 'downloads',
      downloads: 'downloads',
      album: 'albums',
      albums: 'albums',
      artist: 'artists',
      artists: 'artists',
      folder: 'folders',
      folders: 'folders',
    };
    if (target in subTabMap) {
      return {
        type: 'navigate_tab',
        tab: 'library',
        librarySubTab: subTabMap[target],
      };
    }
    const tabMap: Record<string, ActiveTab> = {
      dashboard: 'dashboard',
      home: 'dashboard',
      stream: 'stream',
      discover: 'stream',
      library: 'library',
      settings: 'settings',
      'theme settings': 'settings',
      theme: 'settings',
      search: 'search',
      scanner: 'scanner',
      'album scanner': 'scanner',
    };
    const resolvedTab = tabMap[target];
    if (resolvedTab) {
      return { type: 'navigate_tab', tab: resolvedTab };
    }
  }

  return null;
}

async function fetchJsonSafe(url: string, timeoutMs = 6500): Promise<unknown | null> {
  if (hasNativeHttpBridge()) {
    try {
      const res = await nativeFetchText(url, timeoutMs);
      if (res?.ok && res.text) {
        return JSON.parse(res.text);
      }
    } catch {
      // Fall through to fetch
    }
  }

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function lookupKnowledgeAndMetadata(
  subjectQuery: string,
  originalPrompt: string,
  context: AiAssistantContextPayload
): Promise<{ reply: string; sources: AiAssistantSource[]; relatedSearchQuery?: string }> {
  const cleanSubject = subjectQuery.trim();
  const sources: AiAssistantSource[] = [];
  const facts: string[] = [];

  const [wikiSearch, itunesRes] = await Promise.all([
    fetchJsonSafe(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        `${cleanSubject} song`
      )}&srlimit=2&format=json&origin=*`
    ),
    fetchJsonSafe(
      `https://itunes.apple.com/search?term=${encodeURIComponent(
        cleanSubject
      )}&entity=song&limit=3`
    ),
  ]);

  let wikiTitle = '';
  const wikiHits = (
    wikiSearch as { query?: { search?: Array<{ title?: string; snippet?: string }> } } | null
  )?.query?.search;
  if (Array.isArray(wikiHits) && wikiHits.length > 0 && wikiHits[0].title) {
    wikiTitle = wikiHits[0].title;
    const summaryData = (await fetchJsonSafe(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle)}`
    )) as {
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    } | null;

    if (summaryData?.extract) {
      const sentences = summaryData.extract
        .split(/(?<=[.!?])\s+/)
        .filter((s) => s.trim().length > 12);
      const sampleSentence = sentences.find((s) =>
        /\b(?:sampl|interpolat|produc|writt|releas|record)/i.test(s)
      );
      const excerpt = [sentences[0], sampleSentence && sampleSentence !== sentences[0] ? sampleSentence : '']
        .filter(Boolean)
        .join(' ');
      if (excerpt) {
        facts.push(excerpt);
      }
      const pageUrl = summaryData.content_urls?.desktop?.page;
      if (pageUrl) {
        sources.push({
          title: `Wikipedia: ${summaryData.title || wikiTitle}`,
          uri: pageUrl,
        });
      }
    }
  }

  const itunesResults = (
    itunesRes as {
      results?: Array<{
        trackName?: string;
        artistName?: string;
        collectionName?: string;
        releaseDate?: string;
        primaryGenreName?: string;
      }>;
    } | null
  )?.results;

  if (Array.isArray(itunesResults) && itunesResults.length > 0) {
    const top = itunesResults[0];
    const year = top.releaseDate ? top.releaseDate.slice(0, 4) : '';
    const metaParts = [
      top.trackName && top.artistName ? `"${top.trackName}" by ${top.artistName}` : '',
      top.collectionName ? `Album: ${top.collectionName}` : '',
      year ? `Released: ${year}` : '',
      top.primaryGenreName ? `Genre: ${top.primaryGenreName}` : '',
    ].filter(Boolean);
    if (metaParts.length > 0) {
      facts.push(metaParts.join(' · '));
    }
  }

  const askingSamples = /\bsampl/i.test(originalPrompt);
  if (facts.length > 0) {
    const note =
      askingSamples && !facts.some((f) => /\bsampl|\binterpolat/i.test(f))
        ? "\n\nI couldn't confirm a documented sample source offline for this track, so I included the verified release info above."
        : '';
    return {
      reply: `${facts.join('\n\n')}${note}`,
      sources,
      relatedSearchQuery: cleanSubject,
    };
  }

  if (context.currentTrack && cleanSubject.includes(context.currentTrack.title)) {
    return {
      reply: `Currently playing "${context.currentTrack.title}" by ${context.currentTrack.artist} (${context.currentTrack.album}). No external sample entry was returned for it, or your connection may be limited.`,
      sources,
      relatedSearchQuery: cleanSubject,
    };
  }

  return {
    reply: `I looked up "${cleanSubject}" but couldn't pull a detailed sample or credits summary right now. Want me to search "${cleanSubject}" on YouTube instead?`,
    sources,
    relatedSearchQuery: cleanSubject,
  };
}

function searchSavedLibraryMatches(query: string, savedTracks: Track[]): Track[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (words.length === 0) return [];

  const scored: Array<{ track: Track; score: number }> = [];
  for (const tr of savedTracks) {
    const hay = `${tr.title} ${tr.artist} ${tr.album} ${tr.genre || ''}`.toLowerCase();
    let hits = 0;
    for (const w of words) {
      if (hay.includes(w)) hits++;
    }
    if (hits === 0) continue;
    const score = hits / words.length + (tr.source === 'local' || tr.isAppDownload ? 0.15 : 0);
    if (hits === words.length || score >= 0.65) {
      scored.push({ track: tr, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.track);
}

async function searchPlayableStreams(
  query: string,
  options?: { wantsVideo?: boolean; wantsMix?: boolean }
): Promise<Track[]> {
  const clean = query.trim();
  if (!clean) return [];

  const category = options?.wantsVideo && !options?.wantsMix ? 'videos' : 'all';
  const primary = await searchStreamsUnified({ query: clean, category });
  if (primary.tracks.length > 0) {
    return primary.tracks;
  }

  // Broad fallback if initial phrased query was overly specific
  const tokens = clean.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length > 2) {
    const simplified = tokens.slice(-2).join(' ');
    const secondary = await searchStreamsUnified({ query: simplified, category: 'all' });
    if (secondary.tracks.length > 0) {
      return secondary.tracks;
    }
  }

  return [];
}

function normalizePlaylistSongKey(track: Pick<Track, 'title' | 'artist'>): string {
  const canon = canonicalSongKey(track.title, track.artist);
  if (canon) return canon;
  return `${track.title} ${track.artist}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isPlayablePlaylistCandidate(
  track: Track,
  wantsMixPlaylist = false
): boolean {
  if (!track || (!track.youtubeId && !track.streamUrl)) return false;
  if (track.source === 'synth') return false;
  if (wantsMixPlaylist) return true;
  if (PLAYLIST_JUNK_RE.test(track.title)) return false;
  if (track.duration > 600) return false;
  const durForCheck = track.duration > 0 ? track.duration : undefined;
  return isIndividualSong(track.title, track.album, durForCheck);
}

function topicRelevanceScore(track: Track, topicTokens: string[]): number {
  if (topicTokens.length === 0) return 1;
  const hay = `${track.artist} ${track.title} ${track.album || ''}`.toLowerCase();
  let matched = 0;
  for (const tok of topicTokens) {
    if (hay.includes(tok)) matched += 1;
  }
  return matched / topicTokens.length;
}

export interface PlaylistResolverDeps {
  searchStreams?: typeof searchStreamsUnified;
  fetchJson?: (url: string, timeoutMs?: number) => Promise<unknown | null>;
  initialTracks?: Track[];
  savedTracks?: Track[];
}

export async function resolvePlaylistTracks(
  directive: Pick<
    PlaylistDirective,
    'topicQuery' | 'requestedCount' | 'wantsPopular' | 'wantsMixPlaylist'
  >,
  deps?: PlaylistResolverDeps
): Promise<Track[]> {
  const searchFn = deps?.searchStreams ?? searchStreamsUnified;
  const fetchJsonFn = deps?.fetchJson ?? fetchJsonSafe;
  const targetCount = Math.max(3, Math.min(30, directive.requestedCount || 12));
  const topic = directive.topicQuery.trim();
  if (!topic) return [];

  const topicTokens = topic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  const collected: Track[] = [];
  const seenIds = new Set<string>();
  const seenYtIds = new Set<string>();
  const seenSongKeys = new Set<string>();

  const tryAdd = (tr: Track | null | undefined, requireTopicMatch = false): boolean => {
    if (!tr || !isPlayablePlaylistCandidate(tr, directive.wantsMixPlaylist)) return false;
    if (seenIds.has(tr.id)) return false;
    if (tr.youtubeId && seenYtIds.has(tr.youtubeId)) return false;
    const songKey = normalizePlaylistSongKey(tr);
    if (songKey && seenSongKeys.has(songKey)) return false;
    if (requireTopicMatch && topicTokens.length > 0 && topicRelevanceScore(tr, topicTokens) === 0) {
      return false;
    }

    seenIds.add(tr.id);
    if (tr.youtubeId) seenYtIds.add(tr.youtubeId);
    if (songKey) seenSongKeys.add(songKey);
    collected.push(tr);
    return true;
  };

  if (Array.isArray(deps?.initialTracks)) {
    for (const tr of deps.initialTracks) {
      tryAdd(tr, false);
      if (collected.length >= targetCount) return collected.slice(0, targetCount);
    }
  }

  // Stage 1: Fetch verified iTunes song seeds + broad YouTube/stream discovery searches in parallel
  const discoveryQueries: Array<{ query: string; category: 'songs' | 'all' }> = [
    { query: topic, category: 'songs' },
    {
      query: directive.wantsPopular ? `${topic} popular songs` : `${topic} hits`,
      category: 'all',
    },
  ];
  if (targetCount > 10) {
    discoveryQueries.push({ query: `${topic} official audio`, category: 'songs' });
  }
  if (targetCount >= 18) {
    discoveryQueries.push({ query: `${topic} greatest hits`, category: 'all' });
  }

  const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
    topic
  )}&entity=song&limit=45`;

  const [itunesRaw, ...searchResults] = await Promise.all([
    fetchJsonFn(itunesUrl, 6500).catch(() => null),
    ...discoveryQueries.map((q) => searchFn({ query: q.query, category: q.category }).catch(() => ({ tracks: [] as Track[] }))),
  ]);

  // Rank discovered tracks so relevant & popular songs enter first
  const candidatePool: Track[] = [];
  for (const res of searchResults) {
    if (Array.isArray(res?.tracks)) {
      candidatePool.push(...res.tracks);
    }
  }

  const scoredPool = candidatePool
    .filter((tr) => isPlayablePlaylistCandidate(tr, directive.wantsMixPlaylist))
    .sort((a, b) => {
      const relDiff =
        topicRelevanceScore(b, topicTokens) - topicRelevanceScore(a, topicTokens);
      if (Math.abs(relDiff) > 0.1) return relDiff;
      return (b.viewCount || 0) - (a.viewCount || 0);
    });

  // First pass: add strongly matching tracks
  for (const tr of scoredPool) {
    tryAdd(tr, topicTokens.length === 1);
    if (collected.length >= targetCount) return collected.slice(0, targetCount);
  }

  // Stage 2: Top up any shortfall using verified individual song seeds from iTunes catalog
  const itunesResults = (
    itunesRaw as {
      results?: Array<{
        trackName?: string;
        artistName?: string;
      }>;
    } | null
  )?.results;

  const missingSeeds: Array<{ artist: string; title: string }> = [];
  if (Array.isArray(itunesResults)) {
    const queuedKeys = new Set<string>(seenSongKeys);
    for (const row of itunesResults) {
      const title = (row.trackName || '').trim();
      const artist = (row.artistName || '').trim();
      if (!title || !artist) continue;
      if (PLAYLIST_JUNK_RE.test(title)) continue;
      const key = canonicalSongKey(title, artist);
      if (!key || queuedKeys.has(key)) continue;
      queuedKeys.add(key);
      missingSeeds.push({ artist, title });
    }
  }

  const BATCH_SIZE = 4;
  for (let i = 0; i < missingSeeds.length && collected.length < targetCount; i += BATCH_SIZE) {
    const batch = missingSeeds.slice(i, i + BATCH_SIZE);
    const resolvedBatch = await Promise.all(
      batch.map((seed) =>
        searchFn({ query: `${seed.artist} ${seed.title}`, category: 'songs' }).catch(() => ({
          tracks: [] as Track[],
        }))
      )
    );
    for (const res of resolvedBatch) {
      for (const candidate of res.tracks || []) {
        if (tryAdd(candidate, false)) break;
      }
      if (collected.length >= targetCount) break;
    }
  }

  // Stage 3: Allow remaining non-strict search candidates before giving up short
  if (collected.length < targetCount) {
    for (const tr of scoredPool) {
      tryAdd(tr, false);
      if (collected.length >= targetCount) break;
    }
  }

  // Stage 4: Blend matching offline saved library songs if stream search still needs more
  if (collected.length < targetCount && Array.isArray(deps?.savedTracks)) {
    for (const tr of deps.savedTracks) {
      tryAdd(tr, true);
      if (collected.length >= targetCount) break;
    }
  }

  return collected.slice(0, targetCount);
}

export async function runSiriAssistantTurn(params: {
  prompt: string;
  context: AiAssistantContextPayload;
  savedTracks: Track[];
  pendingAction: PendingSiriAction | null;
}): Promise<SiriTurnResult> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    return {
      reply: 'Ask me to play a song or mix, identify lyrics, adjust EQ, or create a playlist.',
      actions: [],
    };
  }

  // 1. Resolve conversational follow-up against pending confirmation ("yes", "play next", "2nd one", "no")
  const pendingMatch = matchPendingConfirmation(prompt, params.pendingAction);
  if (pendingMatch && params.pendingAction) {
    if (pendingMatch.decision === 'cancel') {
      return {
        reply: 'Okay, cancelled. Tell me what else you would like to play or do.',
        actions: [],
        clearPending: true,
        nextPending: null,
      };
    }

    if (params.pendingAction.kind === 'tracks' && params.pendingAction.tracks.length > 0) {
      const chosen =
        params.pendingAction.tracks[pendingMatch.selectedIndex] ||
        params.pendingAction.tracks[0];
      const verb =
        pendingMatch.playMode === 'play_next'
          ? 'Queued to play next:'
          : pendingMatch.playMode === 'add_to_queue'
            ? 'Added to queue:'
            : 'Playing now:';
      return {
        reply: `${verb} ${formatTrackSummaryLine(chosen)}.`,
        actions: [
          {
            type: 'play_song',
            query: buildAiTrackSearchQuery({ title: chosen.title, artist: chosen.artist }),
            title: chosen.title,
            artist: chosen.artist,
            mode: pendingMatch.playMode,
          },
        ],
        resolvedTracks: [chosen],
        clearPending: true,
        nextPending: null,
      };
    }

    if (params.pendingAction.kind === 'playlist' && params.pendingAction.tracks.length > 0) {
      return {
        reply: `Starting your "${params.pendingAction.name}" playlist now.`,
        actions: [],
        createdPlaylist: {
          name: params.pendingAction.name,
          description: params.pendingAction.description,
          tracks: params.pendingAction.tracks,
          autoPlay: true,
        },
        clearPending: true,
        nextPending: null,
      };
    }
  }

  // 2. Direct App Control / Playback / Navigation / Download / Favorite
  const controlAction = extractAppControlAction(prompt);
  if (controlAction) {
    if (controlAction.type === 'control_playback') {
      if (controlAction.command === 'pause') {
        return {
          reply: params.context.currentTrack
            ? `Paused "${params.context.currentTrack.title}".`
            : 'Paused playback.',
          actions: [controlAction],
        };
      }
      if (controlAction.command === 'play') {
        return {
          reply: params.context.currentTrack
            ? `Resuming "${params.context.currentTrack.title}".`
            : 'Starting playback.',
          actions: [controlAction],
        };
      }
      if (controlAction.command === 'next') {
        return { reply: 'Skipped to the next track.', actions: [controlAction] };
      }
      if (controlAction.command === 'previous') {
        return { reply: 'Going back to the previous track.', actions: [controlAction] };
      }
      if (controlAction.command === 'seek_relative') {
        const sec = controlAction.valueSeconds ?? 10;
        return {
          reply: `${sec >= 0 ? 'Skipped forward' : 'Rewound'} ${Math.abs(sec)} seconds.`,
          actions: [controlAction],
        };
      }
      const commandReplies: Record<string, string> = {
        toggle: 'Toggled playback.',
        toggle_shuffle: 'Toggled shuffle mode.',
        toggle_autoplay_radio: 'Toggled Autoplay Radio.',
        open_fullscreen: 'Opened the Fullscreen Player.',
        open_lyrics: 'Opened Sync Lyrics.',
        open_dsp: 'Opened DSP Audio & Equalizer Studio.',
        open_live_studio: 'Opened Shared Live Studio.',
        pick_song: 'Opening the song file picker.',
        pick_folder: 'Opening the music folder picker.',
      };
      return {
        reply: commandReplies[controlAction.command] || 'Updated player control.',
        actions: [controlAction],
      };
    }

    if (controlAction.type === 'toggle_favorite_current') {
      if (!params.context.currentTrack) {
        return {
          reply: 'No track is currently playing to update favorites for.',
          actions: [],
        };
      }
      return {
        reply: controlAction.favorite
          ? `Added "${params.context.currentTrack.title}" to your Favorites.`
          : `Removed "${params.context.currentTrack.title}" from Favorites.`,
        actions: [controlAction],
      };
    }

    if (controlAction.type === 'download_current_track') {
      if (!params.context.currentTrack) {
        return {
          reply: 'Play a song first so I know which track to download.',
          actions: [],
        };
      }
      return {
        reply:
          controlAction.destination === 'device'
            ? `Downloading "${params.context.currentTrack.title}" (${controlAction.formatId || 'mp3-160'}) to your device.`
            : `Saving "${params.context.currentTrack.title}" for offline playback in kaGO.PIaY.`,
        actions: [controlAction],
      };
    }

    if (controlAction.type === 'navigate_tab') {
      const label = controlAction.librarySubTab
        ? `${controlAction.tab} (${controlAction.librarySubTab})`
        : controlAction.tab;
      return {
        reply: `Opened ${label}.`,
        actions: [controlAction],
      };
    }
  }

  // 3. DSP / Equalizer / Bass Boost / Crossfade
  const dspAction = extractDspDirective(prompt);
  if (dspAction) {
    const summary: string[] = [];
    if (dspAction.eqPreset) summary.push(`EQ preset ${dspAction.eqPreset}`);
    if (dspAction.bassBoostEnabled !== undefined) {
      summary.push(
        dspAction.bassBoostEnabled
          ? `Bass Boost +${dspAction.bassBoostDb ?? 8}dB`
          : 'Bass Boost off'
      );
    }
    if (dspAction.crossfadeSeconds !== undefined) {
      summary.push(`Crossfade ${dspAction.crossfadeSeconds}s`);
    }
    return {
      reply: `Applied ${summary.join(', ')}.`,
      actions: [dspAction],
    };
  }

  // 4. Create Playlist for Artist / Genre / Mood / Specific Count (e.g. "look for twenty popular drake songs and create a custom playlist")
  const playlistDirective = parsePlaylistDirective(prompt);
  if (playlistDirective) {
    const deduped = await resolvePlaylistTracks(playlistDirective, {
      savedTracks: params.savedTracks,
    });

    if (deduped.length === 0) {
      return {
        reply: `I tried searching for playable tracks for "${playlistDirective.topicQuery}", but couldn't find stream matches right now. Check your internet connection or try a more specific artist or genre.`,
        actions: [],
      };
    }

    const previewNames = deduped
      .slice(0, 4)
      .map((t) => `"${t.title}"`)
      .join(', ');

    const countNote =
      playlistDirective.explicitCount && deduped.length < playlistDirective.requestedCount
        ? `Found ${deduped.length} of the ${playlistDirective.requestedCount} unique playable songs I searched for`
        : `Created playlist "${playlistDirective.name}" with ${deduped.length} playable songs`;

    const replyText =
      playlistDirective.explicitCount && deduped.length < playlistDirective.requestedCount
        ? `${countNote} and created "${playlistDirective.name}" in your Library (including ${previewNames}).${playlistDirective.autoPlay ? ' Playing now!' : ' Want me to play it now?'}`
        : `${countNote} (including ${previewNames}) and saved it to your Library.${playlistDirective.autoPlay ? ' Playing now!' : ' Want me to play it now?'}`;

    return {
      reply: replyText,
      actions: [],
      createdPlaylist: {
        name: playlistDirective.name,
        description: `Created by Ai for "${playlistDirective.topicQuery}" (${deduped.length} tracks)`,
        tracks: deduped,
        autoPlay: playlistDirective.autoPlay,
      },
      nextPending: playlistDirective.autoPlay
        ? null
        : {
            kind: 'playlist',
            name: playlistDirective.name,
            description: `Created by Ai for "${playlistDirective.topicQuery}"`,
            tracks: deduped,
          },
    };
  }

  // 5. Identify Song by Lyrics
  const lyricsSnippet = extractLyricsSnippet(prompt);
  if (lyricsSnippet) {
    const [lrcJson, ytTracks] = await Promise.all([
      fetchJsonSafe(`https://lrclib.net/api/search?q=${encodeURIComponent(lyricsSnippet)}`),
      searchPlayableStreams(lyricsSnippet),
    ]);

    const candidateSeeds: Array<{ title: string; artist: string }> = [];
    if (Array.isArray(lrcJson)) {
      for (const row of lrcJson.slice(0, 4) as Array<{ trackName?: string; artistName?: string }>) {
        if (row.trackName && row.artistName) {
          candidateSeeds.push({ title: row.trackName, artist: row.artistName });
        }
      }
    }

    const resolvedFromLyrics: Track[] = [];
    if (candidateSeeds.length > 0) {
      const searched = await Promise.all(
        candidateSeeds.slice(0, 2).map((c) => searchPlayableStreams(`${c.artist} ${c.title}`))
      );
      for (const list of searched) {
        if (list[0]) resolvedFromLyrics.push(list[0]);
      }
    }

    const combined: Track[] = [];
    const seen = new Set<string>();
    for (const tr of [...resolvedFromLyrics, ...ytTracks]) {
      if (!tr || seen.has(tr.id)) continue;
      seen.add(tr.id);
      combined.push(tr);
      if (combined.length >= 3) break;
    }

    if (combined.length === 0) {
      return {
        reply: `I couldn't find an exact match for the lyrics "${lyricsSnippet}". Try adding a few more words from the chorus or an artist name.`,
        actions: [],
      };
    }

    const top = combined[0];
    return {
      reply: `Based on those lyrics, the top match is ${formatTrackSummaryLine(top)}. Would you like me to play it now?`,
      actions: [],
      awaitingConfirmTracks: combined,
      nextPending: {
        kind: 'tracks',
        tracks: combined,
        label: lyricsSnippet,
      },
    };
  }

  // 6. Music Knowledge / Sample Origin / Current Song Q&A
  if (isMusicKnowledgeQuestion(prompt)) {
    const asksCurrentOnly =
      /\bwhat\s+song\s+is\s+(?:this|playing)\b|\bwhat\s+is\s+playing\b|\bwho\s+sings\s+this\b/i.test(
        prompt
      );
    if (asksCurrentOnly) {
      if (params.context.currentTrack) {
        return {
          reply: `Now playing "${params.context.currentTrack.title}" by ${params.context.currentTrack.artist} (${params.context.currentTrack.album}).`,
          actions: [],
        };
      }
      return {
        reply: 'Nothing is playing right now. Tell me a song, artist, or YouTube mix you want me to find!',
        actions: [],
      };
    }

    let subject = prompt
      .replace(/^(?:where\s+was|what\s+song\s+does|who\s+sampled|who\s+produced|who\s+made|who\s+wrote|tell\s+me\s+about|when\s+was|what\s+album\s+is)\s+/i, '')
      .replace(/\b(?:sampled\s+from|sample\s+of|samples\s+from|the\s+beat\s+in|released\s*\??|from\??)\b/gi, ' ')
      .replace(/\bthis\s+(?:song|track)\b|\bcurrent\s+(?:song|track)\b/gi, params.context.currentTrack ? `${params.context.currentTrack.title} ${params.context.currentTrack.artist}` : '')
      .replace(/[?"“”]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!subject && params.context.currentTrack) {
      subject = `${params.context.currentTrack.title} ${params.context.currentTrack.artist}`;
    }

    if (!subject) {
      return {
        reply: 'Which song or artist would you like me to look up?',
        actions: [],
      };
    }

    const knowledge = await lookupKnowledgeAndMetadata(subject, prompt, params.context);
    return {
      reply: knowledge.reply,
      actions: [],
      sources: knowledge.sources,
    };
  }

  // 7. Interactive Song / Mix / Video / Library Search with Confirmation!
  const { query, wantsMix, wantsVideo, wantsOffline, requestedMode } =
    extractSongSearchQuery(prompt);

  if (wantsOffline) {
    const libMatches = searchSavedLibraryMatches(query, params.savedTracks);
    if (libMatches.length > 0) {
      const top = libMatches[0];
      return {
        reply: `I found ${formatTrackSummaryLine(top)} in your Offline Library. Should I play it now?`,
        actions: [],
        awaitingConfirmTracks: libMatches.slice(0, 3),
        nextPending: {
          kind: 'tracks',
          tracks: libMatches.slice(0, 3),
          label: query,
        },
      };
    }
  }

  const foundTracks = await searchPlayableStreams(query, { wantsVideo, wantsMix });
  if (foundTracks.length === 0) {
    // Also check local saved library before reporting nothing found
    const libFallback = searchSavedLibraryMatches(query, params.savedTracks);
    if (libFallback.length > 0) {
      const top = libFallback[0];
      return {
        reply: `No live stream came back for "${query}", but I found ${formatTrackSummaryLine(top)} in your Offline Library. Would you like me to play it?`,
        actions: [],
        awaitingConfirmTracks: libFallback.slice(0, 3),
        nextPending: {
          kind: 'tracks',
          tracks: libFallback.slice(0, 3),
          label: query,
        },
      };
    }

    return {
      reply: `I searched YouTube and your library for "${query}", but couldn't find any playable results right now. Try mentioning the exact artist name or song title.`,
      actions: [],
    };
  }

  const topTracks = foundTracks.slice(0, 3);
  const top = topTracks[0];

  if (requestedMode === 'play_next') {
    return {
      reply: `Found ${formatTrackSummaryLine(top)} and queued it to play next.`,
      actions: [],
      resolvedTracks: [top],
      awaitingConfirmTracks: topTracks,
      clearPending: true,
    };
  }

  if (requestedMode === 'add_to_queue') {
    return {
      reply: `Found ${formatTrackSummaryLine(top)} and added it to your queue.`,
      actions: [],
      resolvedTracks: [top],
      awaitingConfirmTracks: topTracks,
      clearPending: true,
    };
  }

  const kindWord = wantsMix ? 'YouTube mix' : wantsVideo ? 'video' : 'song';
  const extraHint =
    topTracks.length > 1
      ? ' Tap "Yes, Play Now" or say "yes" (or say "second one" for the alternate result).'
      : ' Tap "Yes, Play Now" or reply "yes".';

  return {
    reply: `I found that ${kindWord}: ${formatTrackSummaryLine(top)}. Should I play it now?${extraHint}`,
    actions: [],
    awaitingConfirmTracks: topTracks,
    nextPending: {
      kind: 'tracks',
      tracks: topTracks,
      label: query,
    },
  };
}
