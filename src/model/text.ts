import type { JSONContent } from '@tiptap/core';
import type { PageBody, TagEntry, TextElement } from './types';

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'tableCell',
  'tableHeader',
  'horizontalRule',
]);

/** Plain text of a TipTap document, blocks separated by newlines. */
export function docToText(doc: JSONContent | undefined): string {
  if (!doc) return '';
  const parts: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === 'text' && node.text) parts.push(node.text);
    else if (node.type === 'hardBreak') parts.push('\n');
    if (node.content) for (const child of node.content) walk(child);
    if (node.type && BLOCK_TYPES.has(node.type)) parts.push('\n');
  };
  walk(doc);
  return parts.join('').replace(/\n{2,}/g, '\n').trim();
}

export function isDocEmpty(doc: JSONContent | undefined): boolean {
  if (!doc || !doc.content || doc.content.length === 0) return true;
  const hasStructure = (node: JSONContent): boolean => {
    if (node.type === 'text' && node.text && node.text.trim()) return true;
    if (
      node.type === 'table' ||
      node.type === 'horizontalRule' ||
      node.type === 'taskList' ||
      node.type === 'image' ||
      node.type === 'bulletList' ||
      node.type === 'orderedList'
    )
      return true;
    if (node.attrs && (node.attrs as Record<string, unknown>).tag) return true;
    return (node.content ?? []).some(hasStructure);
  };
  return !doc.content.some(hasStructure);
}

/** Tagged paragraphs and to-do items of a document. */
export function docTags(doc: JSONContent | undefined): TagEntry[] {
  const out: TagEntry[] = [];
  if (!doc) return out;
  const walk = (node: JSONContent) => {
    if (node.type === 'taskItem') {
      out.push({ tag: 'todo', text: docToText({ type: 'doc', content: node.content?.slice(0, 1) }), checked: !!node.attrs?.checked });
    } else if ((node.type === 'paragraph' || node.type === 'heading') && node.attrs?.tag) {
      out.push({ tag: String(node.attrs.tag), text: docToText(node) });
    }
    if (node.content) for (const child of node.content) walk(child);
  };
  walk(doc);
  return out;
}

export function textElementsInOrder(body: PageBody): TextElement[] {
  return Object.values(body.elements)
    .filter((e): e is TextElement => e.type === 'text')
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

export function pageSearchText(title: string, body: PageBody): string {
  const texts = textElementsInOrder(body).map((e) => docToText(e.doc));
  return [title, ...texts].join('\n').toLowerCase();
}

export function pageTags(body: PageBody): TagEntry[] {
  return textElementsInOrder(body).flatMap((e) => docTags(e.doc));
}

export function paragraphDoc(text: string): JSONContent {
  const lines = text.split(/\r?\n/);
  return {
    type: 'doc',
    content: lines.map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  };
}

export function snippetAround(text: string, query: string, radius = 60): string {
  const idx = text.indexOf(query);
  if (idx < 0) return text.slice(0, radius * 2).replace(/\s+/g, ' ');
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}
