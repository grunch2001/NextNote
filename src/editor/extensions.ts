import { Extension, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { TextAlign } from '@tiptap/extension-text-align';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { NoteTags } from './tags';

export const FONTS: Array<{ label: string; value: string }> = [
  { label: 'Calibri', value: 'Calibri, Carlito, "Segoe UI", Roboto, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, "Liberation Sans", sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", Roboto, "Noto Sans", sans-serif' },
  { label: 'Verdana', value: 'Verdana, "DejaVu Sans", sans-serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Tinos, "Noto Serif", serif' },
  { label: 'Georgia', value: 'Georgia, "Noto Serif", serif' },
  { label: 'Courier New', value: '"Courier New", Cousine, "Roboto Mono", monospace' },
  { label: 'Comic Sans MS', value: '"Comic Sans MS", "Comic Neue", cursive' },
];

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

export function fontStack(label: string): string {
  return FONTS.find((f) => f.label === label)?.value ?? FONTS[0].value;
}

export function formatDate(d = new Date()) {
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatTime(d = new Date()) {
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export interface EditorHooks {
  onLinkShortcut(): void;
}

export const editorHooks: EditorHooks = {
  onLinkShortcut: () => {},
};

/** OneNote keyboard shortcuts that TipTap does not have by default. */
const OneNoteShortcuts = Extension.create({
  name: 'oneNoteShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-.': () => this.editor.commands.toggleBulletList(),
      'Mod-/': () => this.editor.commands.toggleOrderedList(),
      'Mod-Shift-n': () => this.editor.chain().setParagraph().unsetAllMarks().run(),
      'Mod-k': () => {
        editorHooks.onLinkShortcut();
        return true;
      },
      'Alt-Shift-d': () => this.editor.commands.insertContent(formatDate()),
      'Alt-Shift-t': () => this.editor.commands.insertContent(formatTime()),
      'Alt-Shift-f': () => this.editor.commands.insertContent(`${formatDate()} ${formatTime()}`),
      'Mod-Shift-.': () => {
        const size = parseFloat(String(this.editor.getAttributes('textStyle').fontSize ?? '11'));
        const next = FONT_SIZES.find((s) => s > size) ?? size;
        return this.editor.commands.setFontSize(`${next}pt`);
      },
      'Mod-Shift-,': () => {
        const size = parseFloat(String(this.editor.getAttributes('textStyle').fontSize ?? '11'));
        const next = [...FONT_SIZES].reverse().find((s) => s < size) ?? size;
        return this.editor.commands.setFontSize(`${next}pt`);
      },
      Tab: () => {
        if (this.editor.isActive('listItem')) return this.editor.commands.sinkListItem('listItem');
        if (this.editor.isActive('taskItem')) return this.editor.commands.sinkListItem('taskItem');
        if (this.editor.isActive('table')) return false;
        return this.editor.commands.insertContent('\t');
      },
    };
  },
});

export function editorExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
      undoRedo: { depth: 300 },
      dropcursor: false,
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({
      nested: true,
      a11y: { checkboxLabel: (node, checked) => `Aufgabe ${checked ? 'erledigt' : 'offen'}: ${node.textContent || 'leer'}` },
    }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 48 } }),
    NoteTags,
    OneNoteShortcuts,
  ];
}
