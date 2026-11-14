export type ThemeMode = 'dark' | 'light';

export interface ThemePreferences {
  mode: ThemeMode;
  accentHex: string;
  accentAlpha: number; // 25 to 100
}

export const DEFAULT_ACCENT_HEX = '#E11D48';

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  mode: 'dark',
  accentHex: DEFAULT_ACCENT_HEX,
  accentAlpha: 100,
};

export const ACCENT_SWATCHES: Array<{ name: string; hex: string }> = [
  { name: 'Crimson', hex: '#E11D48' },
  { name: 'Electric Blue', hex: '#2563EB' },
  { name: 'Cyan', hex: '#06B6D4' },
  { name: 'Emerald', hex: '#10B981' },
  { name: 'Violet', hex: '#8B5CF6' },
  { name: 'Magenta', hex: '#EC4899' },
  { name: 'Amber', hex: '#F59E0B' },
];

const THEME_STORAGE_KEY = 'kago_theme_preferences';

export function normalizeHex(input: string): string | null {
  const cleaned = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const expanded = cleaned
      .split('')
      .map((c) => c + c)
      .join('');
    return `#${expanded.toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `#${cleaned.toUpperCase()}`;
  }
  return null;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const norm = normalizeHex(hex) || DEFAULT_ACCENT_HEX;
  const num = parseInt(norm.slice(1), 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) {
      h = ((gn - bn) / d) % 6;
    } else if (max === gn) {
      h = (bn - rn) / d + 2;
    } else {
      h = (rn - gn) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  return {
    h: Math.round(h),
    s: Math.round(s),
    v: Math.round(v),
  };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const val = Math.max(0, Math.min(100, v)) / 100;

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  let rp = 0;
  let gp = 0;
  let bp = 0;

  if (hue < 60) {
    rp = c;
    gp = x;
  } else if (hue < 120) {
    rp = x;
    gp = c;
  } else if (hue < 180) {
    gp = c;
    bp = x;
  } else if (hue < 240) {
    gp = x;
    bp = c;
  } else if (hue < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }

  return rgbToHex((rp + m) * 255, (gp + m) * 255, (bp + m) * 255);
}

export function mixHex(hexA: string, hexB: string, ratioB: number): string {
  const t = Math.max(0, Math.min(1, ratioB));
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t
  );
}

export function getContrastTextColor(hex: string): '#FFFFFF' | '#0A0B0F' {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return lum > 0.44 ? '#0A0B0F' : '#FFFFFF';
}

export function deriveAccentPalette(
  accentHex: string,
  mode: ThemeMode,
  accentAlpha = 100
) {
  const base = normalizeHex(accentHex) || DEFAULT_ACCENT_HEX;
  const clampedAlpha = Math.max(25, Math.min(100, Math.round(accentAlpha)));
  const alphaRatio = clampedAlpha / 100;
  const effectiveBase =
    alphaRatio < 1
      ? mixHex(mode === 'dark' ? '#14161D' : '#E2E8F0', base, alphaRatio)
      : base;

  const { r, g, b } = hexToRgb(effectiveBase);
  const hover = mixHex(effectiveBase, '#000000', 0.16);
  const dark = mixHex(effectiveBase, '#000000', 0.36);
  const light =
    mode === 'dark'
      ? mixHex(effectiveBase, '#FFFFFF', 0.28)
      : mixHex(effectiveBase, '#000000', 0.18);
  const soft =
    mode === 'dark'
      ? mixHex(effectiveBase, '#FFFFFF', 0.56)
      : mixHex(effectiveBase, '#000000', 0.28);
  const onAccent = getContrastTextColor(effectiveBase);

  return {
    base: effectiveBase,
    hover,
    light,
    soft,
    dark,
    rgb: `${r}, ${g}, ${b}`,
    alpha: alphaRatio,
    onAccent,
  };
}

export function loadThemePreferences(): ThemePreferences {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_THEME_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<ThemePreferences>;
    return {
      mode: parsed.mode === 'light' ? 'light' : 'dark',
      accentHex: normalizeHex(parsed.accentHex || '') || DEFAULT_ACCENT_HEX,
      accentAlpha:
        typeof parsed.accentAlpha === 'number'
          ? Math.max(25, Math.min(100, Math.round(parsed.accentAlpha)))
          : 100,
    };
  } catch {
    return DEFAULT_THEME_PREFERENCES;
  }
}

export function saveThemePreferences(prefs: ThemePreferences): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors
  }
}

export function applyThemeToDocument(prefs: ThemePreferences): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const isLight = prefs.mode === 'light';

  root.classList.toggle('light', isLight);
  root.classList.toggle('dark', !isLight);
  root.style.colorScheme = isLight ? 'light' : 'dark';

  const palette = deriveAccentPalette(prefs.accentHex, prefs.mode, prefs.accentAlpha);
  root.style.setProperty('--kago-accent', palette.base);
  root.style.setProperty('--kago-accent-hover', palette.hover);
  root.style.setProperty('--kago-accent-light', palette.light);
  root.style.setProperty('--kago-accent-soft', palette.soft);
  root.style.setProperty('--kago-accent-dark', palette.dark);
  root.style.setProperty('--kago-accent-rgb', palette.rgb);
  root.style.setProperty('--kago-accent-on-accent', palette.onAccent);

  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    themeColorMeta.setAttribute('content', isLight ? '#F3F4F8' : '#000000');
  }
}
