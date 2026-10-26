import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform } from '../platform';

export type ThemeMode = 'system' | 'light' | 'dark';
/** How far ahead of the pen the live stroke is drawn (browser prediction). */
export type InkPrediction = 'off' | 'moderate' | 'full';

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
  /** Use stylus pressure for the line width. */
  pressure: boolean;
  inkPrediction: InkPrediction;
  /** Draw the live stroke on a desynchronized canvas (lower latency, not in step with the page). */
  inkLowLatency: boolean;
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
      pressure: true,
      inkPrediction: 'moderate',
      inkLowLatency: false,
      invertInkInDark: true,
      defaultFont: 'Calibri',
      defaultFontSize: 11,
      set: (key, value) => set({ [key]: value } as Partial<Settings>),
    }),
    { name: 'nextnote.settings', version: 1 },
  ),
);
