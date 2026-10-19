import { useEffect, useSyncExternalStore } from 'react';
import { useSettings } from '../state/settings';

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function systemDark() {
  return media?.matches ?? false;
}

export function useIsDark(): boolean {
  const theme = useSettings((s) => s.theme);
  const sys = useSyncExternalStore(
    (cb) => {
      media?.addEventListener('change', cb);
      return () => media?.removeEventListener('change', cb);
    },
    systemDark,
  );
  return theme === 'dark' || (theme === 'system' && sys);
}

let darkNow = false;
export const isDarkNow = () => darkNow;

/** Applies the theme to <html> and keeps the Android status bar in sync. */
export function useApplyTheme() {
  const dark = useIsDark();
  useEffect(() => {
    darkNow = dark;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#2b2b2b' : '#7a3fb8');
  }, [dark]);
  return dark;
}
