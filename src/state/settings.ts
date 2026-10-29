import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform } from '../platform';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemeMode;
  /** Seconds between automatic syncs, 0 = only manually / on change. */
  syncInterval: number;
  /** The stylus always draws, even when the text tool is active (like Samsung Notes). */
  penAlwaysDraws: boolean;
  /** Fingers draw instead of scrolling when a pen tool is active. */
  drawWithFinger: boolean;
  /** Holding the S Pen side button erases. */
  penButtonErases: boolean;
  /** The width of new strokes follows the stylus pressure (off: even width, like Samsung Notes' pen). */
  pressure: boolean;
  /** Show dark ink as light in dark mode. */
  invertInkInDark: boolean;
  defaultFont: string;
  defaultFontSize: number;
  set<K extends keyof Omit<Settings, 'set'>>(key: K, value: Settings[K]): void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      theme: 'system',
      syncInterval: 60,
      penAlwaysDraws: platform.kind === 'android',
      drawWithFinger: false,
      penButtonErases: true,
      pressure: false,
      invertInkInDark: true,
      defaultFont: 'Calibri',
      defaultFontSize: 11,
      set: (key, value) => set({ [key]: value } as Partial<Settings>),
    }),
    {
      name: 'nextnote.settings',
      version: 3,
      migrate: (state, version) => {
        const s = state as Partial<Settings> & { inkPrediction?: string };
        if (version < 3) {
          // 1.3: new strokes have an even width by default, the prediction setting is gone
          s.pressure = false;
          delete s.inkPrediction;
        }
        return s as Settings;
      },
    },
  ),
);
