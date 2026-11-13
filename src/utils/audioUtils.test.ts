import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilename } from './filenameSanitizer';
import { parseLrc, formatLrcTimestamp, findActiveLyricIndex, formatDuration } from './lrcParser';
import { parseId3v2Buffer } from './audioMetadata';
import {
  extractYouTubeSearchResults,
  isIndividualSong,
  parseYouTubeArtistAndTitle,
  parseYouTubeDuration,
  sortStudioQueue,
} from './streamFilter';
import type { StudioQueueItem } from '../types/audio';

test('sanitizeFilename cleans noisy YouTube rip filenames and separates artist and title', () => {
  const res = sanitizeFilename('04 - Daft_Punk_-_Derezzed_(Official_Video)_[4K_HQ_320kbps].mp3');
  assert.equal(res.artist, 'Daft Punk');
  assert.equal(res.title, 'Derezzed');
  assert.equal(res.displayName, 'Daft Punk - Derezzed');
});

test('sanitizeFilename preserves meaningful qualifiers and detects OST/Album brackets', () => {
  const res = sanitizeFilename('07_kavinsky_-_nightcall_(drive_ost)_[official_music_video]\uFFFD.m4a');
  assert.equal(res.artist, 'kavinsky');
  assert.equal(res.title, 'nightcall');
  assert.equal(res.album, 'drive ost');
});

test('parseLrc parses timestamps, sorts lines, and ignores metadata tags', () => {
  const raw = [
    '[ti:Cyber Resonance]',
    '[ar:kaGO Synth]',
    '[00:15.50] Signal locked in the dark',
    '[00:05.00] Booting hardware rack',
    '[00:30.25] Crimson frequency rising',
  ].join('\n');

  const lines = parseLrc(raw);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].time, 5);
  assert.equal(lines[0].text, 'Booting hardware rack');
  assert.equal(lines[1].time, 15.5);
  assert.equal(lines[2].time, 30.25);
});

test('findActiveLyricIndex respects calibration offset', () => {
  const lines = parseLrc('[00:10.00] First line\n[00:20.00] Second line');
  assert.equal(findActiveLyricIndex(lines, 9.5, 0), -1);
  assert.equal(findActiveLyricIndex(lines, 9.5, 0.8), 0);
  assert.equal(findActiveLyricIndex(lines, 20.5, -1.0), 0);
  assert.equal(findActiveLyricIndex(lines, 20.5, 0), 1);
});

test('formatLrcTimestamp and formatDuration format time accurately', () => {
  assert.equal(formatLrcTimestamp(65.42), '[01:05.42]');
  assert.equal(formatDuration(185), '3:05');
  assert.equal(formatDuration(3665), '1:01:05');
});

test('isIndividualSong strictly rejects 30s previews, mixes, playlists, and >15m sets', () => {
  assert.equal(isIndividualSong('Midnight City', 'Hurry Up', 243), true);
  assert.equal(isIndividualSong('Short Preview Clip', 'Single', 30), false);
  assert.equal(isIndividualSong('Synthwave 1 Hour Mix', 'Various', 3600), false);
  assert.equal(isIndividualSong('Afrobeats Nonstop DJ Set', 'Club', 700), false);
  assert.equal(isIndividualSong('Deep Focus Playlist', 'Study', 300), false);
});

test('parseYouTubeDuration and parseYouTubeArtistAndTitle parse full-length metadata cleanly', () => {
  assert.equal(parseYouTubeDuration('2:54'), 174);
  assert.equal(parseYouTubeDuration('1:02:05'), 3725);
  assert.equal(parseYouTubeDuration('LIVE'), 0);

  const parsed = parseYouTubeArtistAndTitle(
    'Burna Boy - Last Last [Official Audio]',
    'Burna Boy - Topic'
  );
  assert.equal(parsed.artist, 'Burna Boy');
  assert.equal(parsed.title, 'Last Last');
});

test('extractYouTubeSearchResults extracts full-length songs and skips shorts and mixes', () => {
  const sampleYtData = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      videoRenderer: {
                        videoId: 'abc12345678',
                        title: { runs: [{ text: 'Kavinsky - Nightcall [Official Audio]' }] },
                        ownerText: { runs: [{ text: 'Kavinsky - Topic' }] },
                        lengthText: { simpleText: '4:18' },
                      },
                    },
                    {
                      videoRenderer: {
                        videoId: 'short000001',
                        title: { runs: [{ text: 'Quick Teaser' }] },
                        ownerText: { runs: [{ text: 'Channel' }] },
                        lengthText: { simpleText: '0:28' },
                      },
                    },
                    {
                      videoRenderer: {
                        videoId: 'mix00000002',
                        title: { runs: [{ text: 'Synthwave 1 Hour Mix' }] },
                        ownerText: { runs: [{ text: 'DJ' }] },
                        lengthText: { simpleText: '58:00' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  const html = `<html><script>var ytInitialData = ${JSON.stringify(sampleYtData)};</script></html>`;
  const extracted = extractYouTubeSearchResults(html);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].videoId, 'abc12345678');
  assert.equal(extracted[0].artist, 'Kavinsky');
  assert.equal(extracted[0].title, 'Nightcall');
  assert.equal(extracted[0].durationSeconds, 258);
});

test('sortStudioQueue orders by upvotes descending then timestamp ascending', () => {
  const baseTrack = {
    id: 't1',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    source: 'synth' as const,
    addedAt: 1000,
  };
  const items: StudioQueueItem[] = [
    { id: 'q1', track: baseTrack, addedBy: 'A', addedAt: 100, upvotes: 1, voterIds: ['u1'] },
    { id: 'q2', track: baseTrack, addedBy: 'B', addedAt: 200, upvotes: 4, voterIds: ['u1', 'u2', 'u3', 'u4'] },
    { id: 'q3', track: baseTrack, addedBy: 'C', addedAt: 50, upvotes: 4, voterIds: ['u1', 'u2', 'u3', 'u4'] },
  ];
  const sorted = sortStudioQueue(items);
  assert.deepEqual(sorted.map((s) => s.id), ['q3', 'q2', 'q1']);
});

test('parseId3v2Buffer extracts TIT2, TPE1, TALB, TRCK from ID3v2.3 header', () => {
  function makeFrame(id: string, text: string): number[] {
    const textBytes = Array.from(new TextEncoder().encode(text));
    const size = 1 + textBytes.length;
    return [
      ...Array.from(new TextEncoder().encode(id)),
      (size >>> 24) & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 8) & 0xff,
      size & 0xff,
      0,
      0,
      3, // UTF-8
      ...textBytes,
    ];
  }
  const frames = [
    ...makeFrame('TIT2', 'Neon Horizon'),
    ...makeFrame('TPE1', 'Analog Ghost'),
    ...makeFrame('TALB', 'Direct Drive'),
    ...makeFrame('TRCK', '03/12'),
  ];
  const tagSize = frames.length;
  const header = [
    0x49, 0x44, 0x33, // ID3
    3, 0, // v2.3
    0,
    (tagSize >>> 21) & 0x7f,
    (tagSize >>> 14) & 0x7f,
    (tagSize >>> 7) & 0x7f,
    tagSize & 0x7f,
  ];
  const buf = new Uint8Array([...header, ...frames]).buffer;
  const parsed = parseId3v2Buffer(buf);
  assert.equal(parsed.title, 'Neon Horizon');
  assert.equal(parsed.artist, 'Analog Ghost');
  assert.equal(parsed.album, 'Direct Drive');
  assert.equal(parsed.trackNumber, 3);
});

test('setup-android-native patches AndroidManifest, Gradle, and copies Java Media/PiP classes idempotently', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { applyAndroidNativeOverrides } = await import('../../scripts/setup-android-native.mjs');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kago-android-test-'));
  try {
    const androidMain = path.join(tmpRoot, 'android', 'app', 'src', 'main');
    fs.mkdirSync(path.join(androidMain, 'java', 'com', 'kagoplay', 'workstation'), { recursive: true });
    fs.symlinkSync(path.resolve(process.cwd(), 'android-native'), path.join(tmpRoot, 'android-native'));

    fs.writeFileSync(
      path.join(androidMain, 'AndroidManifest.xml'),
      `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale"
            android:exported="true">
        </activity>
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(tmpRoot, 'android', 'app', 'build.gradle'),
      `dependencies {\n    implementation "androidx.appcompat:appcompat:1.6.1"\n}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'android', 'variables.gradle'),
      `ext {\n    compileSdkVersion = 34\n    targetSdkVersion = 34\n}\n`,
      'utf8'
    );

    applyAndroidNativeOverrides(tmpRoot);
    applyAndroidNativeOverrides(tmpRoot); // verify idempotency

    const manifest = fs.readFileSync(path.join(androidMain, 'AndroidManifest.xml'), 'utf8');
    assert.ok(manifest.includes('FOREGROUND_SERVICE_MEDIA_PLAYBACK'));
    assert.ok(manifest.includes('POST_NOTIFICATIONS'));
    assert.ok(manifest.includes('android:supportsPictureInPicture="true"'));
    assert.ok(manifest.includes('.KaGoMediaService'));
    assert.ok(manifest.includes('smallestScreenSize'));

    const gradle = fs.readFileSync(path.join(tmpRoot, 'android', 'app', 'build.gradle'), 'utf8');
    assert.equal(gradle.match(/androidx\.media:media:1\.7\.0/g)?.length, 1);

    assert.ok(fs.existsSync(path.join(androidMain, 'java', 'com', 'kagoplay', 'workstation', 'MainActivity.java')));
    assert.ok(fs.existsSync(path.join(androidMain, 'java', 'com', 'kagoplay', 'workstation', 'KaGoMediaService.java')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
