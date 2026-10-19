import { useSyncExternalStore } from 'react';
import type { Editor } from '@tiptap/core';
import type { ID } from '../model/types';

let active: Editor | null = null;
let activeElementId: ID | null = null;
const listeners = new Set<() => void>();

/** All mounted text box editors by element id. */
export const editorsById = new Map<ID, Editor>();

/** Whether the last user input was typing (editor undo) or a page operation (page undo). */
export let lastInputKind: 'text' | 'page' = 'page';
export function setLastInputKind(kind: 'text' | 'page') {
  lastInputKind = kind;
}

export function setActiveEditor(editor: Editor | null, elementId: ID | null = null) {
  if (active === editor) return;
  active = editor;
  activeElementId = editor ? elementId : null;
  for (const l of listeners) l();
}

export function getActiveEditor(): Editor | null {
  if (active && active.isDestroyed) {
    active = null;
    activeElementId = null;
  }
  return active;
}

export function getActiveElementId(): ID | null {
  return activeElementId;
}

export function useActiveEditor(): Editor | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getActiveEditor(),
  );
}
