import { platform } from '../platform';
import type { PageElement } from '../model/types';
import { elementClipboard, setElementClipboard } from '../state/page';

/** Written to the system clipboard when page elements are copied, so a later paste knows they were copied last. */
export const CLIPBOARD_MARKER = '⁣NextNote-Elemente⁣';

/** System clipboard text right after the last element copy (in case writing the marker was not allowed). */
let textAtCopy: string | null = null;
/** Time of the last element copy. */
let copiedAt = 0;

/** Copies page elements (strokes, images, text boxes) into the app clipboard. */
export async function copyElements(els: PageElement[]) {
  setElementClipboard(els);
  copiedAt = Date.now();
  // Android can tell when the system clipboard changed, so nothing has to be written there
  // (no "copied" preview and no odd keyboard suggestion).
  if (platform.clipboardChangedSince) {
    textAtCopy = null;
    return;
  }
  textAtCopy = CLIPBOARD_MARKER;
  try {
    await platform.writeClipboardText(CLIPBOARD_MARKER);
  } catch {
    // not allowed: remember what the system clipboard contains now instead
    try {
      textAtCopy = (await platform.readClipboard()).text;
    } catch {
      textAtCopy = null;
    }
  }
}

/** Marks a copy done through the browser's own copy event (Ctrl+C), which already set the marker. */
export function noteMarkerCopied() {
  textAtCopy = CLIPBOARD_MARKER;
  copiedAt = Date.now();
}

/** True if a clipboard text (from a paste event or the system clipboard) means "paste the copied elements". */
export function textMeansElements(text: string | null | undefined): boolean {
  if (!elementClipboard.length) return false;
  if (!text) return true;
  return text === CLIPBOARD_MARKER || (textAtCopy !== null && text === textAtCopy);
}

export type PasteSource = { kind: 'elements'; elements: PageElement[] } | { kind: 'image'; blob: Blob } | { kind: 'text'; text: string };

/** Whatever was copied last: page elements, an image or text. */
export async function readPasteSource(): Promise<PasteSource | null> {
  if (elementClipboard.length && platform.clipboardChangedSince) {
    const changed = await platform.clipboardChangedSince(copiedAt).catch(() => null);
    // false: nothing was copied since; null: unknown – the app's own copy is the best guess
    if (changed !== true) return { kind: 'elements', elements: elementClipboard };
  }
  let text: string | null = null;
  let image: Blob | null = null;
  try {
    const c = await platform.readClipboard();
    text = c.text;
    image = c.image;
  } catch {
    // clipboard not readable
  }
  if (elementClipboard.length && !platform.clipboardChangedSince && textMeansElements(text) && !(image && !text)) {
    return { kind: 'elements', elements: elementClipboard };
  }
  if (image) return { kind: 'image', blob: image };
  if (text && text.trim() && text !== CLIPBOARD_MARKER) return { kind: 'text', text };
  if (elementClipboard.length) return { kind: 'elements', elements: elementClipboard };
  return null;
}
