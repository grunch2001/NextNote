import { useState, type ReactNode } from 'react';
import { useEditorState } from '@tiptap/react';
import type { ChainedCommands, Editor } from '@tiptap/core';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Baseline,
  Bold,
  Calendar,
  Camera,
  ClipboardPaste,
  ChevronDown,
  Circle,
  Clock,
  Columns3,
  Eraser,
  FilePlus,
  FilePlus2,
  FileText,
  Highlighter,
  Image,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Lasso,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Maximize2,
  Minus,
  MousePointer2,
  MoveRight,
  PanelLeft,
  RemoveFormatting,
  Rows3,
  Slash,
  Square,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
  Underline,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Moon,
  Sun,
  Rows2,
  Hand,
  PenLine,
} from 'lucide-react';
import { editorsById, getActiveEditor, lastInputKind, targetEditor, useActiveEditor } from '../editor/active';
import { FONT_SIZES, FONTS, fontStack, formatDate, formatTime } from '../editor/extensions';
import { TAGS } from '../editor/tags';
import { HIGHLIGHT_COLORS, HIGHLIGHTER_INK_COLORS, INK_COLORS, PAGE_COLORS, TEXT_COLORS } from '../model/colors';
import type { RuleStyle } from '../model/types';
import { db } from '../db/db';
import { repo } from '../state/repo';
import { pageActions, usePage } from '../state/page';
import { useSettings } from '../state/settings';
import { useUI, type PenPreset } from '../state/ui';
import { platform, isTouchDevice } from '../platform';
import { useLiveQuery } from 'dexie-react-hooks';
import { pickFiles } from './assets';
import { promptDialog } from './Dialogs';
import { newPage } from './actions';
import { pageApi } from './page/PageView';
import { SpectrumPicker } from './ColorPicker';
import { Popover, usePopover } from './Popover';
import { useIsDark } from './theme';

// ------------------------------------------------------------------ helpers

function keep(e: React.SyntheticEvent) {
  // keep the focus (and selection) in the text editor
  e.preventDefault();
}

function RButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  big,
  title,
  className,
}: {
  icon: ReactNode;
  label?: string;
  onClick(e: React.MouseEvent<HTMLButtonElement>): void;
  active?: boolean;
  disabled?: boolean;
  big?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`rbtn${big ? ' big' : ''}${active ? ' active' : ''}${className ? ' ' + className : ''}`}
      onMouseDown={keep}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={active}
    >
      {icon}
      {label && big && <span className="rbtn-label">{label}</span>}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rgroup" role="group" aria-label={label}>
      <div className="rgroup-items">{children}</div>
      <div className="rgroup-label">{label}</div>
    </div>
  );
}

/** Runs a command on the target editor, or creates a text box first. */
export function withEditor(fn: (chain: ChainedCommands, editor: Editor) => void, editor: Editor | null = targetEditor()) {
  const ed = editor;
  if (ed && !ed.isDestroyed) {
    fn(ed.chain().focus(), ed);
    return;
  }
  const c = pageApi.viewCenter();
  const id = pageApi.createTextAt(c.x, c.y);
  if (!id) return;
  const created = editorsById.get(id);
  if (created) {
    fn(created.chain().focus('end'), created);
    return;
  }
  let tries = 0;
  const wait = () => {
    const e = editorsById.get(id);
    if (e) fn(e.chain().focus('end'), e);
    else if (tries++ < 30) setTimeout(wait, 30);
  };
  setTimeout(wait, 30);
}

function doUndo() {
  const ed = getActiveEditor();
  if (ed && lastInputKind === 'text' && ed.can().undo()) ed.chain().focus().undo().run();
  else pageActions.undo();
}

function doRedo() {
  const ed = getActiveEditor();
  if (ed && lastInputKind === 'text' && ed.can().redo()) ed.chain().focus().redo().run();
  else pageActions.redo();
}

function UndoRedo() {
  const canUndo = usePage((s) => s.undoStack.length > 0);
  const canRedo = usePage((s) => s.redoStack.length > 0);
  const editor = useActiveEditor();
  const ed = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ undo: e?.can().undo() ?? false, redo: e?.can().redo() ?? false }),
  });
  return (
    <Group label="Rückgängig">
      <RButton icon={<Undo2 size={18} />} title="Rückgängig (Strg+Z)" onClick={doUndo} disabled={!canUndo && !ed?.undo} />
      <RButton icon={<Redo2 size={18} />} title="Wiederholen (Strg+Y)" onClick={doRedo} disabled={!canRedo && !ed?.redo} />
    </Group>
  );
}

function ColorGrid({ colors, onPick, extra }: { colors: string[]; onPick(c: string | null): void; extra?: string }) {
  return (
    <div className="color-pop">
      {extra && (
        <button type="button" className="color-none" onMouseDown={keep} onClick={() => onPick(null)}>
          {extra}
        </button>
      )}
      <div className="swatch-grid">
        {colors.map((c) => (
          <button key={c} type="button" className="swatch" style={{ background: c }} onMouseDown={keep} onClick={() => onPick(c)} aria-label={c} />
        ))}
      </div>
    </div>
  );
}

function SplitColorButton({ icon, title, current, colors, extra, apply }: { icon: ReactNode; title: string; current: string; colors: string[]; extra: string; apply(c: string | null): void }) {
  const pop = usePopover();
  return (
    <span className="split">
      <button type="button" className="rbtn color-btn" onMouseDown={keep} onClick={() => apply(current)} title={title} aria-label={title}>
        {icon}
        <span className="color-bar" style={{ background: current }} />
      </button>
      <button type="button" className="rbtn caret" onMouseDown={keep} onClick={(e) => pop.toggle(e.currentTarget)} aria-label={`${title} wählen`}>
        <ChevronDown size={12} />
      </button>
      {pop.open && (
        <Popover anchor={pop.anchor} onClose={pop.close}>
          <ColorGrid
            colors={colors}
            extra={extra}
            onPick={(c) => {
              apply(c);
              pop.close();
            }}
          />
        </Popover>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ Start

function HomeTab() {
  const editor = useActiveEditor();
  const defaultFont = useSettings((s) => s.defaultFont);
  const defaultSize = useSettings((s) => s.defaultFontSize);
  const [textColor, setTextColor] = useState('#C00000');
  const [hlColor, setHlColor] = useState('#FFFF00');
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const ts = e.getAttributes('textStyle');
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        sub: e.isActive('subscript'),
        sup: e.isActive('superscript'),
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        task: e.isActive('taskList'),
        left: e.isActive({ textAlign: 'left' }),
        center: e.isActive({ textAlign: 'center' }),
        right: e.isActive({ textAlign: 'right' }),
        h1: e.isActive('heading', { level: 1 }),
        h2: e.isActive('heading', { level: 2 }),
        h3: e.isActive('heading', { level: 3 }),
        quote: e.isActive('blockquote'),
        code: e.isActive('codeBlock'),
        fontFamily: (ts.fontFamily as string | undefined) ?? null,
        fontSize: (ts.fontSize as string | undefined) ?? null,
        tag: (e.getAttributes('paragraph').tag as string | undefined) ?? (e.getAttributes('heading').tag as string | undefined) ?? null,
      };
    },
  });
  const run = (fn: (c: ChainedCommands) => ChainedCommands) => withEditor((c) => void fn(c).run());
  const fontLabel = st?.fontFamily ? (FONTS.find((f) => f.value === st.fontFamily)?.label ?? st.fontFamily.split(',')[0].replace(/"/g, '')) : defaultFont;
  const sizeValue = st?.fontSize ? parseFloat(st.fontSize) : defaultSize;
  const style = st?.h1 ? 'h1' : st?.h2 ? 'h2' : st?.h3 ? 'h3' : st?.quote ? 'quote' : st?.code ? 'code' : 'p';
  const tagPop = usePopover();

  return (
    <>
      <UndoRedo />
      <Group label="Schriftart">
        <div className="rstack">
          <div className="rrow">
            <select
              className="rselect font"
              value={fontLabel}
              aria-label="Schriftart"
              onChange={(e) => run((c) => c.setFontFamily(fontStack(e.target.value)))}
            >
              {FONTS.map((f) => (
                <option key={f.label} value={f.label} style={{ fontFamily: f.value }}>
                  {f.label}
                </option>
              ))}
              {!FONTS.some((f) => f.label === fontLabel) && <option value={fontLabel}>{fontLabel}</option>}
            </select>
            <select className="rselect size" value={sizeValue} aria-label="Schriftgrad" onChange={(e) => run((c) => c.setFontSize(`${e.target.value}pt`))}>
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              {!FONT_SIZES.includes(sizeValue) && <option value={sizeValue}>{sizeValue}</option>}
            </select>
          </div>
          <div className="rrow">
            <RButton icon={<Bold size={17} />} title="Fett (Strg+B)" active={st?.bold} onClick={() => run((c) => c.toggleBold())} />
            <RButton icon={<Italic size={17} />} title="Kursiv (Strg+I)" active={st?.italic} onClick={() => run((c) => c.toggleItalic())} />
            <RButton icon={<Underline size={17} />} title="Unterstrichen (Strg+U)" active={st?.underline} onClick={() => run((c) => c.toggleUnderline())} />
            <RButton icon={<Strikethrough size={17} />} title="Durchgestrichen" active={st?.strike} onClick={() => run((c) => c.toggleStrike())} />
            <RButton icon={<Subscript size={17} />} title="Tiefgestellt" active={st?.sub} onClick={() => run((c) => c.toggleSubscript())} />
            <RButton icon={<Superscript size={17} />} title="Hochgestellt" active={st?.sup} onClick={() => run((c) => c.toggleSuperscript())} />
            <SplitColorButton
              icon={<Highlighter size={17} />}
              title="Texthervorhebungsfarbe"
              current={hlColor}
              colors={HIGHLIGHT_COLORS}
              extra="Keine Farbe"
              apply={(c) => {
                if (c) {
                  setHlColor(c);
                  run((ch) => ch.setHighlight({ color: c }));
                } else run((ch) => ch.unsetHighlight());
              }}
            />
            <SplitColorButton
              icon={<Baseline size={17} />}
              title="Schriftfarbe"
              current={textColor}
              colors={TEXT_COLORS}
              extra="Automatisch"
              apply={(c) => {
                if (c) {
                  setTextColor(c);
                  run((ch) => ch.setColor(c));
                } else run((ch) => ch.unsetColor());
              }}
            />
            <RButton icon={<RemoveFormatting size={17} />} title="Formatierung löschen" onClick={() => run((c) => c.unsetAllMarks().clearNodes())} />
          </div>
        </div>
      </Group>
      <Group label="Absatz">
        <div className="rstack">
          <div className="rrow">
            <RButton icon={<List size={17} />} title="Aufzählung (Strg+.)" active={st?.bullet} onClick={() => run((c) => c.toggleBulletList())} />
            <RButton icon={<ListOrdered size={17} />} title="Nummerierung (Strg+/)" active={st?.ordered} onClick={() => run((c) => c.toggleOrderedList())} />
            <RButton
              icon={<IndentDecrease size={17} />}
              title="Einzug verkleinern"
              onClick={() => run((c) => (getActiveEditor()?.isActive('taskItem') ? c.liftListItem('taskItem') : c.liftListItem('listItem')))}
            />
            <RButton
              icon={<IndentIncrease size={17} />}
              title="Einzug vergrößern"
              onClick={() => run((c) => (getActiveEditor()?.isActive('taskItem') ? c.sinkListItem('taskItem') : c.sinkListItem('listItem')))}
            />
          </div>
          <div className="rrow">
            <RButton icon={<AlignLeft size={17} />} title="Linksbündig" active={st?.left} onClick={() => run((c) => c.setTextAlign('left'))} />
            <RButton icon={<AlignCenter size={17} />} title="Zentriert" active={st?.center} onClick={() => run((c) => c.setTextAlign('center'))} />
            <RButton icon={<AlignRight size={17} />} title="Rechtsbündig" active={st?.right} onClick={() => run((c) => c.setTextAlign('right'))} />
          </div>
        </div>
      </Group>
      <Group label="Formatvorlagen">
        <div className="styles-list">
          {(
            [
              ['h1', 'Überschrift 1', (c: ChainedCommands) => c.setHeading({ level: 1 })],
              ['h2', 'Überschrift 2', (c: ChainedCommands) => c.setHeading({ level: 2 })],
              ['h3', 'Überschrift 3', (c: ChainedCommands) => c.setHeading({ level: 3 })],
              ['p', 'Standard', (c: ChainedCommands) => c.setParagraph()],
              ['quote', 'Zitat', (c: ChainedCommands) => c.setParagraph().toggleBlockquote()],
              ['code', 'Code', (c: ChainedCommands) => c.toggleCodeBlock()],
            ] as const
          ).map(([key, label, fn]) => (
            <button key={key} type="button" className={`style-chip style-${key}${style === key ? ' active' : ''}`} onMouseDown={keep} onClick={() => run(fn)}>
              {label}
            </button>
          ))}
        </div>
      </Group>
      <Group label="Tags">
        <RButton big icon={<ListChecks size={20} />} label="Aufgabe" title="Aufgabe (Strg+1)" active={st?.task} onClick={() => run((c) => c.toggleTaskList())} />
        <span className="tag-picker">
          <button type="button" className="rbtn big" onMouseDown={keep} onClick={(e) => tagPop.toggle(e.currentTarget)} aria-label="Tags">
            <span className={`tag-dot big tag-${st?.tag ?? 'important'}`} />
            <span className="rbtn-label">
              Tags <ChevronDown size={11} />
            </span>
          </button>
          {tagPop.open && (
            <Popover anchor={tagPop.anchor} onClose={tagPop.close} className="menu-pop">
              {TAGS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`menu-item${st?.tag === t.id ? ' active' : ''}`}
                  onMouseDown={keep}
                  onClick={() => {
                    tagPop.close();
                    run((c) => c.toggleTag(t.id));
                  }}
                >
                  <span className="menu-icon">
                    <span className={`tag-dot tag-${t.id}`} />
                  </span>
                  {t.label}
                  <span className="menu-shortcut">{t.shortcut}</span>
                </button>
              ))}
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item"
                onMouseDown={keep}
                onClick={() => {
                  tagPop.close();
                  run((c) => c.clearTags());
                }}
              >
                <span className="menu-icon" />
                Tag entfernen
                <span className="menu-shortcut">Strg+0</span>
              </button>
            </Popover>
          )}
        </span>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Einfügen

function TablePicker({ onPick }: { onPick(rows: number, cols: number): void }) {
  const [hover, setHover] = useState({ r: 2, c: 3 });
  const N = 8;
  return (
    <div className="table-picker">
      <div className="table-grid" style={{ gridTemplateColumns: `repeat(${N}, 1fr)` }}>
        {Array.from({ length: N * N }, (_, i) => {
          const r = Math.floor(i / N) + 1;
          const c = (i % N) + 1;
          return (
            <button
              key={i}
              type="button"
              className={`tcell${r <= hover.r && c <= hover.c ? ' on' : ''}`}
              onMouseDown={keep}
              onPointerEnter={() => setHover({ r, c })}
              onClick={() => onPick(r, c)}
              aria-label={`${r} × ${c}`}
            />
          );
        })}
      </div>
      <div className="table-picker-label">
        {hover.c} × {hover.r} Tabelle
      </div>
    </div>
  );
}

async function insertLink() {
  const ed = targetEditor();
  const prev = (ed?.getAttributes('link').href as string | undefined) ?? '';
  const url = await promptDialog({ title: 'Link einfügen', label: 'Adresse (URL)', value: prev || 'https://', ok: 'Einfügen' });
  if (url === null) return;
  withEditor((c, e) => {
    if (!url.trim() || url.trim() === 'https://') {
      c.extendMarkRange('link').unsetLink().run();
      return;
    }
    const href = /^[a-z]+:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    if (e.state.selection.empty && !e.isActive('link')) c.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    else c.extendMarkRange('link').setLink({ href }).run();
  }, ed);
}

export { insertLink };

function InsertTab() {
  const tablePop = usePopover();
  return (
    <>
      <Group label="Zwischenablage">
        <RButton
          big
          icon={<ClipboardPaste size={20} />}
          label="Einfügen"
          title="Einfügen – Lasso-Auswahl, Text oder Bild aus der Zwischenablage (Strg+V)"
          onClick={() => void pageApi.paste()}
        />
      </Group>
      <Group label="Seiten">
        <RButton big icon={<FilePlus size={20} />} label="Neue Seite" title="Neue Seite (Strg+N)" onClick={() => void newPage()} />
        <RButton big icon={<FilePlus2 size={20} />} label="Unterseite" title="Neue Unterseite" onClick={() => void newPage({ subpage: true })} />
      </Group>
      <Group label="Tabellen">
        <span>
          <RButton big icon={<Table size={20} />} label="Tabelle" onClick={(e) => tablePop.toggle(e.currentTarget)} />
          {tablePop.open && (
            <Popover anchor={tablePop.anchor} onClose={tablePop.close}>
              <TablePicker
                onPick={(rows, cols) => {
                  tablePop.close();
                  withEditor((c) => void c.insertTable({ rows, cols, withHeaderRow: false }).run());
                }}
              />
            </Popover>
          )}
        </span>
      </Group>
      <Group label="Bilder">
        <RButton
          big
          icon={<Image size={20} />}
          label="Bild"
          title="Bild aus Datei einfügen"
          onClick={async () => {
            const files = await pickFiles('image/*', { multiple: true });
            if (files.length) await pageApi.insertImages(files);
          }}
        />
        {(platform.kind === 'android' || isTouchDevice) && (
          <RButton
            big
            icon={<Camera size={20} />}
            label="Kamera"
            title="Foto aufnehmen"
            onClick={async () => {
              const files = await pickFiles('image/*', { capture: 'environment' });
              if (files.length) await pageApi.insertImages(files);
            }}
          />
        )}
      </Group>
      <Group label="Dateien">
        <RButton
          big
          icon={<FileText size={20} />}
          label="PDF-Ausdruck"
          title="PDF als Ausdruck einfügen (zum Beschriften mit dem Stift)"
          onClick={async () => {
            const files = await pickFiles('application/pdf,.pdf');
            for (const f of files) await pageApi.insertPdf(f);
          }}
        />
      </Group>
      <Group label="Links">
        <RButton big icon={<Link size={20} />} label="Link" title="Link (Strg+K)" onClick={() => void insertLink()} />
      </Group>
      <Group label="Zeitstempel">
        <RButton big icon={<Calendar size={20} />} label="Datum" title="Datum (Alt+Umschalt+D)" onClick={() => withEditor((c) => void c.insertContent(formatDate()).run())} />
        <RButton big icon={<Clock size={20} />} label="Uhrzeit" title="Uhrzeit (Alt+Umschalt+T)" onClick={() => withEditor((c) => void c.insertContent(formatTime()).run())} />
      </Group>
      <Group label="Symbole">
        <RButton big icon={<Minus size={20} />} label="Linie" title="Horizontale Linie" onClick={() => withEditor((c) => void c.setHorizontalRule().run())} />
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Zeichnen

function PenEditor({ preset, colors, sizes, onChange }: { preset: PenPreset; colors: string[]; sizes: number[]; onChange(p: Partial<PenPreset>): void }) {
  const [spectrumOpen, setSpectrumOpen] = useState(false);
  const custom = !colors.some((c) => c.toLowerCase() === preset.color.toLowerCase());
  // shrink the preview dots proportionally so the thickest one still fits its button
  const dotScale = Math.min(1, 26 / (Math.max(...sizes) + 2));
  return (
    <div className="pen-editor">
      <div className="pen-sizes">
        {sizes.map((s) => {
          const active = Math.abs(preset.size - s) < 0.01;
          const dot = (s + 2) * dotScale;
          return (
            <button key={s} type="button" className={`pen-size${active ? ' active' : ''}`} onClick={() => onChange({ size: s })} aria-label={`Stärke ${s}`} aria-pressed={active}>
              <span style={{ width: dot, height: dot, background: preset.color }} />
            </button>
          );
        })}
      </div>
      <div className="swatch-grid">
        {colors.map((c) => (
          <button key={c} type="button" className={`swatch${preset.color.toLowerCase() === c.toLowerCase() ? ' current' : ''}`} style={{ background: c }} onClick={() => onChange({ color: c })} aria-label={c} />
        ))}
        <button
          type="button"
          className={`swatch swatch-spectrum${custom ? ' current' : ''}`}
          onClick={() => setSpectrumOpen((o) => !o)}
          aria-label="Eigene Farbe"
          aria-expanded={spectrumOpen}
          title="Eigene Farbe aus dem ganzen Farbspektrum"
        >
          {custom && <span style={{ background: preset.color }} />}
        </button>
      </div>
      {spectrumOpen && <SpectrumPicker color={preset.color} onChange={(color) => onChange({ color })} />}
    </div>
  );
}

function PenButton({ preset, active, kind, onSelect, onChange }: { preset: PenPreset; active: boolean; kind: 'pen' | 'highlighter'; onSelect(): void; onChange(p: Partial<PenPreset>): void }) {
  const pop = usePopover();
  const dark = useIsDark();
  return (
    <span className="pen-btn-wrap">
      <button
        type="button"
        className={`pen-btn ${kind}${active ? ' active' : ''}`}
        onMouseDown={keep}
        onClick={(e) => {
          if (active) pop.toggle(e.currentTarget);
          else onSelect();
        }}
        title={kind === 'pen' ? 'Stift (nochmal tippen für Farbe & Stärke)' : 'Textmarker (nochmal tippen für Farbe & Stärke)'}
        aria-label={kind === 'pen' ? 'Stift' : 'Textmarker'}
      >
        <svg viewBox="0 0 24 40" width="20" height="34" aria-hidden="true">
          {kind === 'pen' ? (
            <>
              <path d="M8 13 L12 2 L16 13 Z" fill={preset.color} stroke={dark ? '#bbb' : '#555'} strokeWidth="0.8" />
              <rect x="7" y="13" width="10" height="25" rx="2" fill={dark ? '#e6e6e6' : '#fafafa'} stroke={dark ? '#bbb' : '#666'} strokeWidth="0.8" />
              <rect x="7" y="16" width="10" height={Math.min(10, 3 + preset.size)} fill={preset.color} />
            </>
          ) : (
            <>
              <path d="M7 12 L9 3 L17 3 L17 12 Z" fill={preset.color} stroke={dark ? '#bbb' : '#555'} strokeWidth="0.8" />
              <rect x="6" y="12" width="12" height="26" rx="2" fill={preset.color} opacity="0.85" stroke={dark ? '#bbb' : '#666'} strokeWidth="0.8" />
            </>
          )}
        </svg>
      </button>
      {pop.open && (
        <Popover anchor={pop.anchor} onClose={pop.close}>
          <PenEditor
            preset={preset}
            colors={kind === 'pen' ? INK_COLORS : HIGHLIGHTER_INK_COLORS}
            sizes={kind === 'pen' ? [1, 1.5, 2.5, 4, 6, 9, 14] : [8, 12, 16, 22, 30]}
            onChange={onChange}
          />
        </Popover>
      )}
    </span>
  );
}

function DrawTab() {
  const ui = useUI();
  const fingerDraws = useSettings((s) => s.drawWithFinger);
  const setSetting = useSettings((s) => s.set);
  const eraserPop = usePopover();
  const tool = ui.tool;
  return (
    <>
      <UndoRedo />
      <Group label="Werkzeuge">
        <RButton big icon={<MousePointer2 size={20} />} label="Text" title="Auswählen & Text eingeben" active={tool === 'select'} onClick={() => ui.setTool('select')} />
        <RButton big icon={<Lasso size={20} />} label="Lasso" title="Lassoauswahl" active={tool === 'lasso'} onClick={() => ui.setTool('lasso')} />
        <span>
          <RButton
            big
            icon={<Eraser size={20} />}
            label="Radierer"
            active={tool === 'eraser'}
            onClick={(e) => {
              if (tool === 'eraser') eraserPop.toggle(e.currentTarget);
              else ui.setTool('eraser');
            }}
          />
          {eraserPop.open && (
            <Popover anchor={eraserPop.anchor} onClose={eraserPop.close} className="menu-pop">
              <button type="button" className={`menu-item${ui.eraserMode === 'stroke' ? ' active' : ''}`} onClick={() => useUI.setState({ eraserMode: 'stroke' })}>
                Ganze Striche radieren
              </button>
              <button type="button" className={`menu-item${ui.eraserMode === 'point' ? ' active' : ''}`} onClick={() => useUI.setState({ eraserMode: 'point' })}>
                Punktgenau radieren
              </button>
              <div className="menu-sep" />
              {[
                ['Klein', 8],
                ['Mittel', 16],
                ['Groß', 32],
              ].map(([label, size]) => (
                <button key={label} type="button" className={`menu-item${ui.eraserSize === size ? ' active' : ''}`} onClick={() => useUI.setState({ eraserSize: size as number })}>
                  Radierer {label}
                </button>
              ))}
            </Popover>
          )}
        </span>
      </Group>
      <Group label="Stifte">
        <div className="pens">
          {ui.pens.map((p, i) => (
            <PenButton key={`p${i}`} preset={p} kind="pen" active={tool === 'pen' && ui.penIndex === i} onSelect={() => ui.setPen(i)} onChange={(patch) => ui.setPen(i, patch)} />
          ))}
          {ui.highlighters.map((p, i) => (
            <PenButton
              key={`h${i}`}
              preset={p}
              kind="highlighter"
              active={tool === 'highlighter' && ui.highlighterIndex === i}
              onSelect={() => ui.setHighlighter(i)}
              onChange={(patch) => ui.setHighlighter(i, patch)}
            />
          ))}
        </div>
      </Group>
      <Group label="Formen">
        <div className="rstack">
          <div className="rrow">
            {(
              [
                ['line', <Slash key="l" size={17} />, 'Linie'],
                ['arrow', <MoveRight key="a" size={17} />, 'Pfeil'],
              ] as const
            ).map(([shape, icon, label]) => (
              <RButton key={shape} icon={icon} title={label} active={tool === 'shape' && ui.shape === shape} onClick={() => useUI.setState({ tool: 'shape', shape })} />
            ))}
          </div>
          <div className="rrow">
            {(
              [
                ['rect', <Square key="r" size={17} />, 'Rechteck'],
                ['ellipse', <Circle key="e" size={17} />, 'Ellipse'],
              ] as const
            ).map(([shape, icon, label]) => (
              <RButton key={shape} icon={icon} title={label} active={tool === 'shape' && ui.shape === shape} onClick={() => useUI.setState({ tool: 'shape', shape })} />
            ))}
          </div>
        </div>
      </Group>
      <Group label="Eingabe">
        <RButton
          big
          icon={fingerDraws ? <PenLine size={20} /> : <Hand size={20} />}
          label={fingerDraws ? 'Finger zeichnet' : 'Finger scrollt'}
          title="Mit dem Finger zeichnen oder scrollen"
          active={fingerDraws}
          onClick={() => setSetting('drawWithFinger', !fingerDraws)}
        />
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Ansicht

const RULES: Array<{ id: RuleStyle; label: string }> = [
  { id: 'none', label: 'Keine Linien' },
  { id: 'lines', label: 'Linien schmal' },
  { id: 'lines-wide', label: 'Linien breit' },
  { id: 'grid', label: 'Kariert' },
  { id: 'dots', label: 'Punkte' },
];

function ViewTab() {
  const zoom = useUI((s) => s.zoom);
  const setZoom = useUI((s) => s.setZoom);
  const navOpen = useUI((s) => s.navOpen);
  const pagesOpen = useUI((s) => s.pagesOpen);
  const pageId = useUI((s) => s.pageId);
  const meta = useLiveQuery(() => (pageId ? db.pages.get(pageId) : undefined), [pageId]);
  const theme = useSettings((s) => s.theme);
  const setSetting = useSettings((s) => s.set);
  const dark = useIsDark();
  const colorPop = usePopover();
  const rulePop = usePopover();
  return (
    <>
      <Group label="Zoom">
        <RButton icon={<ZoomOut size={18} />} title="Verkleinern" onClick={() => setZoom(zoom - 0.1)} />
        <button type="button" className="rbtn zoom-value" onMouseDown={keep} onClick={() => setZoom(1)} title="100 %">
          {Math.round(zoom * 100)} %
        </button>
        <RButton icon={<ZoomIn size={18} />} title="Vergrößern" onClick={() => setZoom(zoom + 0.1)} />
      </Group>
      <Group label="Seite">
        <span>
          <RButton big icon={<span className="page-color-icon" style={{ background: meta?.bgColor ?? 'var(--page-bg)' }} />} label="Seitenfarbe" onClick={(e) => colorPop.toggle(e.currentTarget)} disabled={!meta} />
          {colorPop.open && meta && (
            <Popover anchor={colorPop.anchor} onClose={colorPop.close} className="menu-pop">
              {PAGE_COLORS.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className={`menu-item${meta.bgColor === c.color ? ' active' : ''}`}
                  onClick={() => {
                    void repo.setPageBackground(meta.id, { bgColor: c.color });
                    colorPop.close();
                  }}
                >
                  <span className="menu-icon">
                    <span className="menu-swatch" style={{ background: c.color ?? 'var(--page-bg)' }} />
                  </span>
                  {c.name}
                </button>
              ))}
            </Popover>
          )}
        </span>
        <span>
          <RButton big icon={<Rows3 size={20} />} label="Linien" onClick={(e) => rulePop.toggle(e.currentTarget)} disabled={!meta} />
          {rulePop.open && meta && (
            <Popover anchor={rulePop.anchor} onClose={rulePop.close} className="menu-pop">
              {RULES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`menu-item${meta.rule === r.id ? ' active' : ''}`}
                  onClick={() => {
                    void repo.setPageBackground(meta.id, { rule: r.id });
                    rulePop.close();
                  }}
                >
                  <span className="menu-icon">
                    <span className={`rule-preview rule-${r.id}`} />
                  </span>
                  {r.label}
                </button>
              ))}
            </Popover>
          )}
        </span>
      </Group>
      <Group label="Fenster">
        <RButton big icon={<PanelLeft size={20} />} label="Notizbücher" active={navOpen} onClick={() => useUI.setState({ navOpen: !navOpen })} />
        <RButton big icon={<Rows2 size={20} />} label="Seitenliste" active={pagesOpen} onClick={() => useUI.setState({ pagesOpen: !pagesOpen })} />
        <RButton
          big
          icon={<Maximize2 size={20} />}
          label="Vollbild"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen?.().catch(() => {});
          }}
        />
        <RButton
          big
          icon={dark ? <Sun size={20} /> : <Moon size={20} />}
          label={dark ? 'Hell' : 'Dunkel'}
          title={theme === 'system' ? 'Design (folgt dem System)' : 'Design umschalten'}
          onClick={() => setSetting('theme', dark ? 'light' : 'dark')}
        />
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Tabelle

function TableTab() {
  const run = (fn: (c: ChainedCommands) => ChainedCommands) => withEditor((c) => void fn(c).run());
  return (
    <>
      <Group label="Einfügen">
        <RButton big icon={<ArrowUpToLine size={20} />} label="Zeile oben" onClick={() => run((c) => c.addRowBefore())} />
        <RButton big icon={<ArrowDownToLine size={20} />} label="Zeile unten" onClick={() => run((c) => c.addRowAfter())} />
        <RButton big icon={<ArrowLeftToLine size={20} />} label="Spalte links" onClick={() => run((c) => c.addColumnBefore())} />
        <RButton big icon={<ArrowRightToLine size={20} />} label="Spalte rechts" onClick={() => run((c) => c.addColumnAfter())} />
      </Group>
      <Group label="Löschen">
        <RButton big icon={<Rows3 size={20} />} label="Zeile" onClick={() => run((c) => c.deleteRow())} />
        <RButton big icon={<Columns3 size={20} />} label="Spalte" onClick={() => run((c) => c.deleteColumn())} />
        <RButton big icon={<Trash2 size={20} />} label="Tabelle" onClick={() => run((c) => c.deleteTable())} />
      </Group>
      <Group label="Zellen">
        <RButton big icon={<TableCellsMerge size={20} />} label="Verbinden" onClick={() => run((c) => c.mergeCells())} />
        <RButton big icon={<TableCellsSplit size={20} />} label="Teilen" onClick={() => run((c) => c.splitCell())} />
        <RButton big icon={<Table size={20} />} label="Kopfzeile" onClick={() => run((c) => c.toggleHeaderRow())} />
      </Group>
    </>
  );
}

export function Ribbon() {
  const tab = useUI((s) => s.ribbonTab);
  const collapsed = useUI((s) => s.ribbonCollapsed);
  if (collapsed) return null;
  return (
    <div className="ribbon" role="toolbar" aria-label="Menüband">
      <div className="ribbon-body">
        {tab === 'home' && <HomeTab />}
        {tab === 'insert' && <InsertTab />}
        {tab === 'draw' && <DrawTab />}
        {tab === 'view' && <ViewTab />}
        {tab === 'table' && <TableTab />}
      </div>
    </div>
  );
}

/** True while the cursor is inside a table (shows the "Tabelle" tab). */
export function useInTable(): boolean {
  const editor = useActiveEditor();
  return useEditorState({ editor, selector: ({ editor: e }) => e?.isActive('table') ?? false }) ?? false;
}
