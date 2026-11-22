import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgba(pngBuffer) {
  if (!pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idatParts = [];

  let offset = 8;
  while (offset + 8 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkData = pngBuffer.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`Unsupported PNG format (depth=${bitDepth}, colorType=${colorType})`);
      }
    } else if (type === 'IDAT') {
      idatParts.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
  }

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const decoded = Buffer.alloc(height * stride);

  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[inPos++];
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const byteVal = raw[inPos++];
      const a = x >= bpp ? decoded[rowStart + x - bpp] : 0;
      const b = y > 0 ? decoded[prevRowStart + x] : 0;
      const c = y > 0 && x >= bpp ? decoded[prevRowStart + x - bpp] : 0;
      let recon = byteVal;
      if (filterType === 1) recon = (byteVal + a) & 0xff;
      else if (filterType === 2) recon = (byteVal + b) & 0xff;
      else if (filterType === 3) recon = (byteVal + ((a + b) >> 1)) & 0xff;
      else if (filterType === 4) recon = (byteVal + paethPredictor(a, b, c)) & 0xff;
      decoded[rowStart + x] = recon;
    }
  }

  if (colorType === 6) {
    return { width, height, rgba: decoded };
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < decoded.length; i += 3, j += 4) {
    rgba[j] = decoded[i];
    rgba[j + 1] = decoded[i + 1];
    rgba[j + 2] = decoded[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

function resizeRgbaBilinear(src, targetW, targetH, circularMask = false) {
  const out = Buffer.alloc(targetW * targetH * 4);
  const scaleX = src.width / targetW;
  const scaleY = src.height / targetH;
  const cx = (targetW - 1) / 2;
  const cy = (targetH - 1) / 2;
  const maxRadius = Math.min(targetW, targetH) * 0.46;

  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;

      const idx00 = (y0 * src.width + x0) * 4;
      const idx10 = (y0 * src.width + x1) * 4;
      const idx01 = (y1 * src.width + x0) * 4;
      const idx11 = (y1 * src.width + x1) * 4;

      const dstIdx = (y * targetW + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = src.rgba[idx00 + ch] * (1 - fx) + src.rgba[idx10 + ch] * fx;
        const bot = src.rgba[idx01 + ch] * (1 - fx) + src.rgba[idx11 + ch] * fx;
        out[dstIdx + ch] = Math.round(top * (1 - fy) + bot * fy);
      }

      if (circularMask) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist > maxRadius + 0.75) {
          out[dstIdx + 3] = 0;
        } else if (dist > maxRadius - 0.75) {
          const aa = Math.max(0, Math.min(1, (maxRadius + 0.75 - dist) / 1.5));
          out[dstIdx + 3] = Math.round(out[dstIdx + 3] * aa);
        }
      }
    }
  }

  return { width: targetW, height: targetH, rgba: out };
}

function encodePngRgba(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const outRow = y * (stride + 1);
    raw[outRow] = 0; // None filter
    rgba.copy(raw, outRow + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function installAndroidLauncherIcons(rootDir, androidMainDir) {
  const publicDir = path.join(rootDir, 'public');
  const iconPngPath = path.join(publicDir, 'pwa-512x512.png');
  const maskablePngPath = path.join(publicDir, 'pwa-maskable-512x512.png');

  if (!fs.existsSync(iconPngPath)) {
    return false;
  }

  const baseIcon = decodePngRgba(fs.readFileSync(iconPngPath));
  const maskableIcon = fs.existsSync(maskablePngPath)
    ? decodePngRgba(fs.readFileSync(maskablePngPath))
    : baseIcon;

  const resDir = path.join(androidMainDir, 'res');
  const densities = [
    { dir: 'mipmap-mdpi', launcherPx: 48, foregroundPx: 108 },
    { dir: 'mipmap-hdpi', launcherPx: 72, foregroundPx: 162 },
    { dir: 'mipmap-xhdpi', launcherPx: 96, foregroundPx: 216 },
    { dir: 'mipmap-xxhdpi', launcherPx: 144, foregroundPx: 324 },
    { dir: 'mipmap-xxxhdpi', launcherPx: 192, foregroundPx: 432 },
  ];

  for (const d of densities) {
    const outDir = path.join(resDir, d.dir);
    fs.mkdirSync(outDir, { recursive: true });

    const legacy = resizeRgbaBilinear(baseIcon, d.launcherPx, d.launcherPx, false);
    fs.writeFileSync(
      path.join(outDir, 'ic_launcher.png'),
      encodePngRgba(legacy.width, legacy.height, legacy.rgba)
    );

    const round = resizeRgbaBilinear(baseIcon, d.launcherPx, d.launcherPx, true);
    fs.writeFileSync(
      path.join(outDir, 'ic_launcher_round.png'),
      encodePngRgba(round.width, round.height, round.rgba)
    );

    const fg = resizeRgbaBilinear(maskableIcon, d.foregroundPx, d.foregroundPx, false);
    fs.writeFileSync(
      path.join(outDir, 'ic_launcher_foreground.png'),
      encodePngRgba(fg.width, fg.height, fg.rgba)
    );
  }

  const valuesDir = path.join(resDir, 'values');
  fs.mkdirSync(valuesDir, { recursive: true });
  fs.writeFileSync(
    path.join(valuesDir, 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#050508</color>\n</resources>\n`,
    'utf8'
  );

  const anyDpiDir = path.join(resDir, 'mipmap-anydpi-v26');
  fs.mkdirSync(anyDpiDir, { recursive: true });
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n`;
  fs.writeFileSync(path.join(anyDpiDir, 'ic_launcher.xml'), adaptiveXml, 'utf8');
  fs.writeFileSync(path.join(anyDpiDir, 'ic_launcher_round.xml'), adaptiveXml, 'utf8');
  return true;
}

export function applyAndroidNativeOverrides(rootDir = process.cwd()) {
  const androidMainDir = path.join(rootDir, 'android', 'app', 'src', 'main');
  const packageJavaDir = path.join(androidMainDir, 'java', 'com', 'kagoplay', 'workstation');
  const nativeSrcDir = path.join(rootDir, 'android-native', 'java', 'com', 'kagoplay', 'workstation');

  if (!fs.existsSync(androidMainDir)) {
    throw new Error(`Android project not found at ${androidMainDir}`);
  }

  fs.mkdirSync(packageJavaDir, { recursive: true });
  for (const file of ['MainActivity.java', 'KaGoMediaService.java']) {
    const src = path.join(nativeSrcDir, file);
    const dst = path.join(packageJavaDir, file);
    fs.copyFileSync(src, dst);
  }

  const iconsInstalled = installAndroidLauncherIcons(rootDir, androidMainDir);

  // Patch AndroidManifest.xml idempotently
  const manifestPath = path.join(androidMainDir, 'AndroidManifest.xml');
  let manifest = fs.readFileSync(manifestPath, 'utf8');

  const permissions = [
    '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />',
    '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '<uses-permission android:name="android.permission.WAKE_LOCK" />',
    '<uses-permission android:name="android.permission.VIBRATE" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',
  ];

  for (const perm of permissions) {
    const nameMatch = perm.match(/android:name="([^"]+)"/);
    if (nameMatch && !manifest.includes(nameMatch[1])) {
      manifest = manifest.replace('<application', `    ${perm}\n\n    <application`);
    }
  }

  // Enable hardware acceleration for smooth WebView video & PiP playback
  manifest = manifest.replace(/<application([^>]*)>/, (full, attrs) => {
    if (attrs.includes('android:hardwareAccelerated')) return full;
    return `<application${attrs}\n        android:hardwareAccelerated="true">`;
  });

  // Enable Picture-in-Picture and resizeableActivity on MainActivity
  if (!manifest.includes('android:supportsPictureInPicture')) {
    manifest = manifest.replace(
      /<activity([^>]*android:name="(?:\.|com\.kagoplay\.workstation\.)MainActivity"[^>]*)>/,
      (_full, attrs) => {
        let updatedAttrs = attrs;
        if (!updatedAttrs.includes('supportsPictureInPicture')) {
          updatedAttrs += '\n            android:supportsPictureInPicture="true"';
        }
        if (!updatedAttrs.includes('resizeableActivity')) {
          updatedAttrs += '\n            android:resizeableActivity="true"';
        }
        if (updatedAttrs.includes('android:configChanges=')) {
          updatedAttrs = updatedAttrs.replace(
            /android:configChanges="([^"]*)"/,
            (_m, existing) => {
              const parts = new Set(existing.split('|').filter(Boolean));
              parts.add('orientation');
              parts.add('screenSize');
              parts.add('smallestScreenSize');
              parts.add('screenLayout');
              parts.add('keyboardHidden');
              return `android:configChanges="${Array.from(parts).join('|')}"`;
            }
          );
        }
        return `<activity${updatedAttrs}>`;
      }
    );
  }

  // Register KaGoMediaService and MediaButtonReceiver
  if (!manifest.includes('.KaGoMediaService')) {
    const serviceBlock = `
        <service
            android:name=".KaGoMediaService"
            android:exported="true"
            android:stopWithTask="false"
            android:foregroundServiceType="mediaPlayback">
            <intent-filter>
                <action android:name="android.intent.action.MEDIA_BUTTON" />
            </intent-filter>
        </service>

        <receiver
            android:name="androidx.media.session.MediaButtonReceiver"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MEDIA_BUTTON" />
            </intent-filter>
        </receiver>
    </application>`;
    manifest = manifest.replace('</application>', serviceBlock);
  }

  fs.writeFileSync(manifestPath, manifest, 'utf8');

  // Patch android/app/build.gradle to ensure androidx.media:media:1.7.0 and Java 17 compileOptions
  const appGradlePath = path.join(rootDir, 'android', 'app', 'build.gradle');
  if (fs.existsSync(appGradlePath)) {
    let gradle = fs.readFileSync(appGradlePath, 'utf8');
    let changed = false;
    if (!gradle.includes('compileOptions')) {
      gradle = gradle.replace(
        /android\s*\{/,
        'android {\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n    }'
      );
      changed = true;
    }
    if (!gradle.includes('androidx.media:media')) {
      gradle = gradle.replace(
        /dependencies\s*\{/,
        'dependencies {\n    implementation "androidx.media:media:1.7.0"'
      );
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(appGradlePath, gradle, 'utf8');
    }
  }

  // Patch variables.gradle to SDK 34 cleanly
  const varsGradlePath = path.join(rootDir, 'android', 'variables.gradle');
  if (fs.existsSync(varsGradlePath)) {
    let vars = fs.readFileSync(varsGradlePath, 'utf8');
    vars = vars
      .replace(/compileSdkVersion\s*=\s*\d+/g, 'compileSdkVersion = 34')
      .replace(/targetSdkVersion\s*=\s*\d+/g, 'targetSdkVersion = 34');
    fs.writeFileSync(varsGradlePath, vars, 'utf8');
  }

  return {
    manifestPath,
    packageJavaDir,
    appGradlePath,
    iconsInstalled,
  };
}

const isCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]));

if (isCli) {
  const res = applyAndroidNativeOverrides(process.cwd());
  console.log('Applied Android native MediaSession, Samsung Now Bar, PiP, and launcher icon config:', res);
}

