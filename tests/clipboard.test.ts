import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../src/platform';
import { CLIPBOARD_MARKER, copyElements, readPasteSource } from '../src/ui/clipboard';
import { inkEl } from './helpers';

function fakeSystemClipboard(initial: { text: string | null; image: Blob | null }, writable = true) {
  const state = { ...initial };
  vi.spyOn(platform, 'readClipboard').mockImplementation(async () => ({ ...state }));
  vi.spyOn(platform, 'writeClipboardText').mockImplementation(async (t) => {
    if (!writable) throw new Error('NotAllowed');
    state.text = t;
    state.image = null;
  });
  return state;
}

afterEach(() => vi.restoreAllMocks());

describe('paste source (what was copied last)', () => {
  it('pastes lasso elements right after copying them', async () => {
    const sys = fakeSystemClipboard({ text: 'irgendwas', image: null });
    const stroke = inkEl();
    await copyElements([stroke]);
    expect(sys.text).toBe(CLIPBOARD_MARKER);
    const src = await readPasteSource();
    expect(src?.kind).toBe('elements');
    expect(src?.kind === 'elements' && src.elements[0].id).toBe(stroke.id);
  });

  it('prefers text that was copied in another app afterwards', async () => {
    const sys = fakeSystemClipboard({ text: null, image: null });
    await copyElements([inkEl()]);
    sys.text = 'Text aus dem Browser';
    expect(await readPasteSource()).toEqual({ kind: 'text', text: 'Text aus dem Browser' });
  });

  it('prefers a screenshot copied afterwards', async () => {
    const sys = fakeSystemClipboard({ text: null, image: null });
    await copyElements([inkEl()]);
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    sys.text = null;
    sys.image = png;
    const src = await readPasteSource();
    expect(src?.kind).toBe('image');
  });

  it('works when the system clipboard cannot be written', async () => {
    const sys = fakeSystemClipboard({ text: 'alt', image: null }, false);
    const stroke = inkEl();
    await copyElements([stroke]);
    expect((await readPasteSource())?.kind).toBe('elements');
    sys.text = 'neu';
    expect(await readPasteSource()).toEqual({ kind: 'text', text: 'neu' });
  });

  it('falls back to the elements if the clipboard cannot be read at all', async () => {
    vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(new Error('no'));
    vi.spyOn(platform, 'readClipboard').mockRejectedValue(new Error('no'));
    await copyElements([inkEl()]);
    expect((await readPasteSource())?.kind).toBe('elements');
  });
});

describe('paste source on Android (clipboard timestamp)', () => {
  it('uses the lasso copy while nothing newer was copied, without touching the system clipboard', async () => {
    let lastSystemCopy = Date.now() - 60_000;
    const write = vi.fn();
    const read = vi.fn(async () => ({ text: 'alter Text', image: null }));
    Object.assign(platform, { clipboardChangedSince: async (t: number) => lastSystemCopy > t });
    vi.spyOn(platform, 'writeClipboardText').mockImplementation(write);
    vi.spyOn(platform, 'readClipboard').mockImplementation(read);
    try {
      const stroke = inkEl();
      await copyElements([stroke]);
      expect(write).not.toHaveBeenCalled();
      const src = await readPasteSource();
      expect(src?.kind === 'elements' && src.elements[0].id).toBe(stroke.id);
      expect(read).not.toHaveBeenCalled(); // no "pasted from clipboard" notice when pasting strokes
      // the user copies text in another app afterwards
      lastSystemCopy = Date.now() + 1;
      read.mockImplementation(async () => ({ text: 'neuer Text', image: null }));
      expect(await readPasteSource()).toEqual({ kind: 'text', text: 'neuer Text' });
    } finally {
      delete (platform as { clipboardChangedSince?: unknown }).clipboardChangedSince;
    }
  });
});
