import { Extension } from '@tiptap/core';

export interface TagDef {
  id: string;
  label: string;
  shortcut: string;
  color: string;
}

/** OneNote-like note tags. "todo" is implemented as a task list. */
export const TAGS: TagDef[] = [
  { id: 'todo', label: 'Aufgabe', shortcut: 'Strg+1', color: '#1976D2' },
  { id: 'important', label: 'Wichtig', shortcut: 'Strg+2', color: '#F4B400' },
  { id: 'question', label: 'Frage', shortcut: 'Strg+3', color: '#7B1FA2' },
  { id: 'remember', label: 'Merken für später', shortcut: 'Strg+4', color: '#E65100' },
  { id: 'definition', label: 'Definition', shortcut: 'Strg+5', color: '#2E7D32' },
  { id: 'idea', label: 'Idee', shortcut: 'Strg+6', color: '#F9A825' },
  { id: 'critical', label: 'Kritisch', shortcut: 'Strg+7', color: '#D32F2F' },
];

export const tagLabel = (id: string) => TAGS.find((t) => t.id === id)?.label ?? id;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    noteTags: {
      toggleTag: (tag: string) => ReturnType;
      clearTags: () => ReturnType;
    };
  }
}

export const NoteTags = Extension.create({
  name: 'noteTags',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          tag: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-tag'),
            renderHTML: (attrs) => (attrs.tag ? { 'data-tag': attrs.tag } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      toggleTag:
        (tag: string) =>
        ({ editor, chain }) => {
          if (tag === 'todo') return chain().toggleTaskList().run();
          const active = editor.isActive('paragraph', { tag }) || editor.isActive('heading', { tag });
          const value = active ? null : tag;
          return chain().updateAttributes('paragraph', { tag: value }).updateAttributes('heading', { tag: value }).run();
        },
      clearTags:
        () =>
        ({ editor, chain }) => {
          let c = chain().updateAttributes('paragraph', { tag: null }).updateAttributes('heading', { tag: null });
          if (editor.isActive('taskList')) c = c.toggleTaskList();
          return c.run();
        },
    };
  },

  addKeyboardShortcuts() {
    const map: Record<string, () => boolean> = {
      'Mod-0': () => this.editor.commands.clearTags(),
    };
    TAGS.forEach((t, i) => {
      map[`Mod-${i + 1}`] = () => this.editor.commands.toggleTag(t.id);
    });
    return map;
  },
});
