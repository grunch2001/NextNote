import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckSquare, FileText, Search, Square, Tag, X } from 'lucide-react';
import { db } from '../db/db';
import type { PageMeta } from '../model/types';
import { snippetAround } from '../model/text';
import { TAGS, tagLabel } from '../editor/tags';
import { useUI } from '../state/ui';

type Scope = 'all' | 'notebook' | 'section';

/** Highlights search terms on the open page using the CSS Custom Highlight API. */
export function highlightTerms(terms: string[]) {
  const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !HighlightCtor) return;
  reg.delete('nn-search');
  if (!terms.length) return;
  setTimeout(() => {
    const root = document.querySelector('.page');
    if (!root) return;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.toLowerCase() ?? '';
      for (const t of terms) {
        let i = text.indexOf(t);
        while (i >= 0) {
          const r = new Range();
          r.setStart(node, i);
          r.setEnd(node, i + t.length);
          ranges.push(r);
          i = text.indexOf(t, i + t.length);
        }
      }
    }
    reg.set('nn-search', new HighlightCtor(...ranges));
  }, 350);
}

export function SearchPanel() {
  const open = useUI((s) => s.searchOpen);
  const notebookId = useUI((s) => s.notebookId);
  const sectionId = useUI((s) => s.sectionId);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [tab, setTab] = useState<'text' | 'tags'>('text');
  const [tagFilter, setTagFilter] = useState<string>('todo');
  const [hideDone, setHideDone] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const pages = useLiveQuery(async () => {
    if (!open) return [] as PageMeta[];
    const all = await db.pages.toArray();
    const sections = new Map((await db.sections.toArray()).map((s) => [s.id, s]));
    return all.filter((p) => p.deletedAt === null && sections.get(p.sectionId)?.deletedAt === null);
  }, [open]);
  const names = useLiveQuery(async () => {
    const nbs = new Map((await db.notebooks.toArray()).map((n) => [n.id, n]));
    const secs = new Map((await db.sections.toArray()).map((s) => [s.id, s]));
    return { nbs, secs };
  }, [open]);

  const terms = useMemo(
    () =>
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    [query],
  );

  const scoped = useMemo(() => {
    const list = pages ?? [];
    if (scope === 'notebook' && notebookId) return list.filter((p) => p.notebookId === notebookId);
    if (scope === 'section' && sectionId) return list.filter((p) => p.sectionId === sectionId);
    return list;
  }, [pages, scope, notebookId, sectionId]);

  const results = useMemo(() => {
    if (!terms.length) return [];
    return scoped
      .filter((p) => terms.every((t) => p.searchText.includes(t)))
      .map((p) => ({ p, titleHit: terms.some((t) => p.title.toLowerCase().includes(t)) }))
      .sort((a, b) => Number(b.titleHit) - Number(a.titleHit) || b.p.updatedAt - a.p.updatedAt)
      .slice(0, 200);
  }, [scoped, terms]);

  const tagged = useMemo(() => {
    const out: Array<{ p: PageMeta; text: string; checked?: boolean; tag: string }> = [];
    for (const p of scoped) {
      for (const t of p.tags) {
        if (t.tag !== tagFilter) continue;
        if (tagFilter === 'todo' && hideDone && t.checked) continue;
        if (terms.length && !terms.every((q) => t.text.toLowerCase().includes(q))) continue;
        out.push({ p, ...t });
      }
    }
    return out.sort((a, b) => b.p.updatedAt - a.p.updatedAt);
  }, [scoped, tagFilter, hideDone, terms]);

  if (!open) return null;
  const close = () => {
    useUI.setState({ searchOpen: false });
    highlightTerms([]);
  };
  const openPage = (p: PageMeta) => {
    useUI.getState().openPage(p.id, p.sectionId, p.notebookId);
    highlightTerms(terms);
    if (window.innerWidth < 760) useUI.setState({ searchOpen: false });
  };
  const where = (p: PageMeta) => `${names?.nbs.get(p.notebookId)?.name ?? ''} › ${names?.secs.get(p.sectionId)?.name ?? ''}`;

  return (
    <aside className="search-panel" aria-label="Suche">
      <div className="search-head">
        <div className="search-box">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder={tab === 'text' ? 'In Notizen suchen' : 'Tags filtern'}
            aria-label="Suchbegriff"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              if (e.key === 'Enter' && results[0]) openPage(results[0].p);
            }}
          />
          {query && (
            <button type="button" className="icon-btn small" aria-label="Suche leeren" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <button type="button" className="icon-btn" aria-label="Suche schließen" onClick={close}>
          <X size={18} />
        </button>
      </div>
      <div className="search-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'text'} className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>
          <FileText size={14} /> Text
        </button>
        <button type="button" role="tab" aria-selected={tab === 'tags'} className={tab === 'tags' ? 'active' : ''} onClick={() => setTab('tags')}>
          <Tag size={14} /> Tags &amp; Aufgaben
        </button>
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Suchbereich">
          <option value="all">Alle Notizbücher</option>
          <option value="notebook">Dieses Notizbuch</option>
          <option value="section">Dieser Abschnitt</option>
        </select>
      </div>
      {tab === 'tags' && (
        <div className="tag-filter">
          {TAGS.map((t) => (
            <button key={t.id} type="button" className={`chip${tagFilter === t.id ? ' active' : ''}`} onClick={() => setTagFilter(t.id)}>
              <span className={`tag-dot tag-${t.id}`} /> {t.label}
            </button>
          ))}
          {tagFilter === 'todo' && (
            <label className="check">
              <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Erledigte ausblenden
            </label>
          )}
        </div>
      )}
      <div className="search-results">
        {tab === 'text' && !terms.length && <p className="empty-state">Suche in Seitentiteln und Text aller Notizbücher.</p>}
        {tab === 'text' && terms.length > 0 && results.length === 0 && <p className="empty-state">Keine Treffer.</p>}
        {tab === 'text' &&
          results.map(({ p }) => (
            <button key={p.id} type="button" className="result" onClick={() => openPage(p)}>
              <span className="result-title">{p.title || 'Unbenannte Seite'}</span>
              <span className="result-where">{where(p)}</span>
              <span className="result-snippet">{snippetAround(p.searchText, terms[0])}</span>
            </button>
          ))}
        {tab === 'tags' && tagged.length === 0 && <p className="empty-state">Keine Einträge mit dem Tag „{tagLabel(tagFilter)}“.</p>}
        {tab === 'tags' &&
          tagged.map((t, i) => (
            <button key={`${t.p.id}-${i}`} type="button" className="result" onClick={() => openPage(t.p)}>
              <span className="result-title tag-line">
                {t.tag === 'todo' ? t.checked ? <CheckSquare size={15} /> : <Square size={15} /> : <span className={`tag-dot tag-${t.tag}`} />}
                {t.text || '(leer)'}
              </span>
              <span className="result-where">
                {where(t.p)} › {t.p.title || 'Unbenannte Seite'}
              </span>
            </button>
          ))}
      </div>
    </aside>
  );
}
