/**
 * The vault editor (plan §4): one CodeMirror 6 instance serving three views —
 *
 *   source  plain markdown + line numbers
 *   live    Obsidian-style live preview: syntax markers hidden on lines the
 *           caret is NOT on, rendered weight on the rest (decorations only,
 *           the document text is never rewritten — byte fidelity is the plan's
 *           D2 invariant)
 *   read    (handled outside this module by MarkdownView + AuxRail)
 *
 * The DOM is never the source of truth: outline anchors are exposed as
 * {level, text, from} document positions so the AuxRail can jump via
 * view.dispatch + scrollIntoView (plan §5.2 — immune to CM6 viewport
 * virtualization, unlike the DOM-scraping approach droplets had to patch).
 */
import { EditorView, keymap, lineNumbers, drawSelection, ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { EditorState, Compartment, EditorSelection, RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { autocompletion, completeFromList } from '@codemirror/autocomplete';
import { parser as mdParser } from '@lezer/markdown';

/** Heading levels the vault outline tracks (h2–h6, plan §5.1). */
const OUTLINE_PATTERN = /^#{2,6}\s+(.+?)\s*#*$/;

// ---------------------------------------------------------------------------
// Live-preview decorations
// ---------------------------------------------------------------------------

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(other) { return other.checked === this.checked; }
  toDOM() {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.style.verticalAlign = 'middle';
    box.style.marginRight = '4px';
    return box;
  }
  ignoreEvent() { return false; }
}

class ImageWidget extends WidgetType {
  constructor(src, alt, loader) {
    super();
    this.src = src;
    this.alt = alt;
    this.loader = loader;
  }
  eq(other) { return other.src === this.src && other.alt === this.alt; }
  toDOM() {
    const wrap = document.createElement('span');
    const img = document.createElement('img');
    img.alt = this.alt ?? '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.style.maxWidth = '100%';
    img.style.borderRadius = '6px';
    const fallback = () => {
      // Broken image: fall back to the raw text so nothing silently vanishes.
      wrap.textContent = `![${this.alt ?? ''}](${this.src})`;
    };
    img.addEventListener('error', fallback);
    const show = (url) => {
      if (!url) { fallback(); return; }
      wrap.textContent = '';
      img.src = url;
      wrap.appendChild(img);
    };
    // The loader may answer synchronously (remote URL) or with a Promise
    // (vault attachment fetched as a data URL); until it lands the raw
    // markdown stays visible, so nothing flashes broken.
    let resolved;
    try { resolved = this.loader?.(this.src); } catch { resolved = null; }
    if (typeof resolved === 'string') {
      show(resolved);
    } else if (resolved && typeof resolved.then === 'function') {
      wrap.textContent = `![${this.alt ?? ''}](${this.src})`;
      resolved.then(show).catch(fallback);
    } else {
      fallback();
    }
    return wrap;
  }
}

/** Markers on the caret's own line stay visible (Obsidian behavior). */
function markDecorations(view) {
  const builder = new RangeSetBuilder();
  const caretLines = new Set();
  for (const range of view.state.selection.ranges) {
    const from = view.state.doc.lineAt(range.from).number;
    const to = view.state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n += 1) caretLines.add(n);
  }
  const syntax = view.state.facet(EditorState.syntax);
  const tree = syntax.length > 0 ? syntax[0].tree : null;
  if (!tree) return Decoration.none;
  const add = [];
  tree.iterate({
    from: 0,
    to: view.state.doc.length,
    enter(node) {
      const name = node.name;
      const line = view.state.doc.lineAt(node.from);
      if (caretLines.has(line.number)) return; // caret line: raw markdown
      // Emphasis / inline code markers
      if (name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'CodeMark') {
        add.push(Decoration.replace({ widget: null }).range(node.from, node.to));
      } else if (name === 'StrongEmphasis') {
        add.push(Decoration.mark({ class: 'cm-live-strong' }).range(node.from, node.to));
      } else if (name === 'Emphasis') {
        add.push(Decoration.mark({ class: 'cm-live-em' }).range(node.from, node.to));
      } else if (name === 'Strikethrough') {
        add.push(Decoration.mark({ class: 'cm-live-strike' }).range(node.from, node.to));
      } else if (name === 'InlineCode') {
        add.push(Decoration.mark({ class: 'cm-live-code' }).range(node.from, node.to));
      } else if (name === 'ATXHeading1') {
        add.push(Decoration.mark({ class: 'cm-live-h1' }).range(node.from, node.to));
      } else if (name === 'ATXHeading2') {
        add.push(Decoration.mark({ class: 'cm-live-h2' }).range(node.from, node.to));
      } else if (name === 'ATXHeading3') {
        add.push(Decoration.mark({ class: 'cm-live-h3' }).range(node.from, node.to));
      } else if (name === 'ATXHeading4' || name === 'ATXHeading5' || name === 'ATXHeading6') {
        add.push(Decoration.mark({ class: 'cm-live-h4' }).range(node.from, node.to));
      }
    },
  });
  add.sort((a, b) => a.from - b.from || b.to - a.to);
  for (const spec of add) builder.add(spec.from, spec.to, spec.value);
  return builder.finish();
}

/** Plain-text level decorations for lines the lezer tree did not reach yet. */
function hideHeadingMarks(view) {
  const builder = new RangeSetBuilder();
  const caretLines = new Set();
  for (const range of view.state.selection.ranges) {
    caretLines.add(view.state.doc.lineAt(range.from).number);
  }
  const text = view.state.doc;
  for (let n = 1; n <= text.lines; n += 1) {
    if (caretLines.has(n)) continue;
    const line = text.line(n);
    const match = /^(#{1,6})\s/.exec(line.text);
    if (match) builder.add(line.from, line.from + match[1].length, Decoration.replace({}));
  }
  return builder.finish();
}

function checkboxDecorations(view) {
  const builder = new RangeSetBuilder();
  const caretLine = view.state.doc.lineAt(view.state.selection.main.from).number;
  const text = view.state.doc;
  for (let n = 1; n <= text.lines; n += 1) {
    if (n === caretLine) continue;
    const line = text.line(n);
    const match = /^(\s*[-*]\s+)\[( |x|X)\]\s*/.exec(line.text);
    if (match) {
      builder.add(line.from, line.from + match[0].length, Decoration.replace({ widget: new CheckboxWidget(match[2].toLowerCase() === 'x') }));
    }
  }
  return builder.finish();
}

/** [[wikilink]] and ![](image) line decorations (line-level regex pass).
 *  Both markdown images `![](path)` and Obsidian embeds `![[name]]` render
 *  through the ImageWidget; resolveImage may return a string (remote URL) or
 *  a Promise (attachment fetched as a data URL). */
function linkDecorations(view, resolveImage) {
  const builder = new RangeSetBuilder();
  const caretLine = view.state.doc.lineAt(view.state.selection.main.from).number;
  const text = view.state.doc;
  const patterns = [
    { re: /!\[([^\]]*)\]\(([^)\s]+)\)/g, kind: 'image', src: (match) => match[2], alt: (match) => match[1] },
    { re: /!\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, kind: 'image', src: (match) => match[1], alt: (match) => match[2] },
    { re: /\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, kind: 'wikilink' },
  ];
  for (let n = 1; n <= text.lines; n += 1) {
    if (n === caretLine) continue;
    const line = text.line(n);
    for (const { re, kind, src, alt } of patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line.text)) !== null) {
        if (kind === 'image') {
          builder.add(line.from + match.index, line.from + match.index + match[0].length, Decoration.replace({ widget: new ImageWidget(src(match), alt?.(match) ?? '', resolveImage) }));
        } else {
          builder.add(
            line.from + match.index,
            line.from + match.index + match[0].length,
            Decoration.mark({ class: 'cm-live-wikilink' }),
          );
        }
      }
    }
  }
  return builder.finish();
}

/**
 * Build the live-preview extension set.
 * @param {(relativePath: string) => string|null} resolveImage absolute URL resolver for ![](…)
 */
export function livePreview({ resolveImage = () => null } = {}) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(update) { if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = this.build(update.view); }
    build(view) {
      // Combine the cheap text-level passes; the lezer-tree pass covers
      // emphasis/heading styling when the parse is available.
      const sets = [hideHeadingMarks(view), checkboxDecorations(view), linkDecorations(view, resolveImage), markDecorations(view)];
      return sets.reduce((acc, set) => (acc === Decoration.none ? set : Decoration.set([...acc.iter(0, view.state.doc.length), ...set.iter(0, view.state.doc.length)], true)), Decoration.none);
    }
  }, {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        // Click a rendered checkbox → flip the task marker in the source.
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === 'checkbox') {
          const pos = view.posAtDOM(target);
          const line = view.state.doc.lineAt(pos);
          const match = /^(\s*[-*]\s+)\[( |x|X)\]/.exec(line.text);
          if (!match) return false;
          const next = match[2] === ' ' ? 'x' : ' ';
          view.dispatch({
            changes: { from: line.from + match[1].length + 1, to: line.from + match[1].length + 2, insert: next },
          });
          return true;
        }
        // Click a rendered [[wikilink]] → hand it to the host callback.
        if (target instanceof Element && target.closest('.cm-live-wikilink') && view.__onWikilink) {
          const pos = view.posAtDOM(target);
          const line = view.state.doc.lineAt(pos);
          const match = /\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/.exec(line.text);
          if (match) {
            view.__onWikilink(match[1].trim());
            return true;
          }
        }
        return false;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Outline extraction (plan §5.2): document positions, DOM-free
// ---------------------------------------------------------------------------

/** Extract h2–h6 outline with document offsets, skipping fenced code. */
export function outlineOf(state) {
  const out = [];
  let inFence = false;
  for (let n = 1; n <= state.doc.lines; n += 1) {
    const line = state.doc.line(n);
    if (/^\s*(```+|~~~+)/.test(line.text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = OUTLINE_PATTERN.exec(line.text);
    if (match) out.push({ level: match[0].match(/^#+/)[0].length, text: match[1].trim(), from: line.from });
  }
  return out;
}

/** Scroll the editor so the heading at `from` lands at the top (48px buffer). */
export function scrollToHeading(view, from) {
  view.dispatch({ selection: EditorSelection.cursor(from), scrollIntoView: false });
  const block = view.lineBlockAt(from);
  view.scrollDOM.scrollTo({ top: Math.max(0, block.top - view.scrollDOM.clientHeight / 8), behavior: 'smooth' });
}

/** Active outline index: last heading whose block crossed the top line. */
export function activeOutlineIndex(view, outline) {
  if (outline.length === 0) return -1;
  const line = view.scrollDOM.getBoundingClientRect().top + 48;
  let active = -1;
  for (let i = 0; i < outline.length; i += 1) {
    const block = view.lineBlockAt(outline[i].from);
    if (block.top <= line) active = i;
  }
  return active;
}

/**
 * Wikilink completion (plan §4.3): typing `[[` opens a fuzzy note list from
 * the caller's file index; picking one inserts `[[name]]`.
 */
export function wikilinkCompletion(noteFiles) {
  const sources = [];
  return autocompletion({
    override: [{
      from: 0,
      to: 0,
      // eslint-disable-next-line no-unused-vars
      matchBefore() { return null; },
      complete(context) {
        const line = context.state.doc.lineAt(context.pos);
        const before = line.text.slice(0, context.pos - line.from);
        const open = before.lastIndexOf('[[');
        if (open === -1 || open + 2 > before.length && before.length !== open + 2) {
          // require a live `[[` with whatever the user typed after it
        }
        if (open === -1) return null;
        const after = before.slice(open + 2);
        if (/[\]\n]/.test(after)) return null;
        const word = after.toLowerCase();
        const options = noteFiles
          .filter((file) => file.name.toLowerCase().includes(word))
          .slice(0, 12)
          .map((file) => ({
            label: file.name.replace(/\.md$/i, ''),
            detail: file.path.split('/').slice(0, -1).join('/'),
            apply: file.name.replace(/\.md$/i, ''),
            type: 'text',
          }));
        return { from: line.from + open + 2, options, validFor: /^[^\]\n]*$/ };
      },
    }],
  });
}

// ---------------------------------------------------------------------------
// Editor factory
// ---------------------------------------------------------------------------

/**
 * Mount a CodeMirror editor.
 * @param {HTMLElement} parent
 * @param {object} options
 * @param {string} options.doc initial markdown
 * @param {(text: string) => void} options.onChange debounced by the caller
 * @param {'source'|'live'} options.mode
 * @param {boolean} options.lineNumbers
 * @param {boolean} options.wrap
 * @param {(relativePath: string) => string|null|Promise<string|null>} options.resolveImage
 * @param {(base64: string, name: string) => Promise<string|null>} options.pasteImage
 *        pasting an image uploads it and returns the vault path to reference
 * @param {Array} options.extraExtensions
 * @returns {{ view: EditorView, setDoc(text): void, setMode(mode): void, setLineNumbers(on): void, setWrap(on): void, destroy(): void }}
 */
export function createVaultEditor(parent, { doc = '', onChange, mode = 'live', lineNumbers: showLines = true, wrap = true, resolveImage, pasteImage, noteFiles = [], onWikilink, extraExtensions = [] } = {}) {
  const liveCompartment = new Compartment();
  const linesCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  let currentMode = mode;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && onChange) onChange(update.state.doc.toString());
  });
  const wikilinkHandler = ViewPlugin.fromClass(class {
    constructor(view) { view.__onWikilink = onWikilink; }
    update(update) { update.view.__onWikilink = onWikilink; }
  });

  // Image paste (plan P1): read the clipboard image as base64, hand it to
  // the caller's uploader, then insert `![](vault-relative-path)` at the
  // paste position once the upload lands.
  const pasteHandler = typeof pasteImage === 'function'
    ? EditorView.domEventHandlers({
        paste(event, view) {
          const items = [...(event.clipboardData?.items ?? [])];
          const item = items.find((candidate) => candidate.type.startsWith('image/'));
          const file = item?.getAsFile?.();
          if (!item || !file) return false;
          event.preventDefault();
          const pos = view.state.selection.main.to;
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = String(reader.result ?? '').split(',')[1] ?? '';
            void Promise.resolve(pasteImage(base64, file.name || 'Pasted image'))
              .then((relPath) => {
                if (!relPath) return;
                const at = Math.min(pos, view.state.doc.length);
                const lineText = view.state.doc.lineAt(at).text;
                const lead = lineText.trim() === '' ? '' : '\n\n';
                view.dispatch({ changes: { from: at, insert: `${lead}![](${relPath})\n` } });
              })
              .catch(() => { /* upload failed: nothing inserted */ });
          };
          reader.readAsDataURL(file);
          return true;
        },
      })
    : [];

  const extensions = [
    linesCompartment.of(showLines ? lineNumbers() : []),
    wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
    history(),
    drawSelection(),
    bracketMatching(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    wikilinkCompletion(noteFiles),
    wikilinkHandler,
    pasteHandler,
    updateListener,
    liveCompartment.of(currentMode === 'live' ? livePreview({ resolveImage }) : []),
    ...extraExtensions,
  ];

  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  });

  return {
    view,
    setDoc(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    setMode(next) {
      currentMode = next;
      view.dispatch({ effects: liveCompartment.reconfigure(next === 'live' ? livePreview({ resolveImage }) : []) });
    },
    setLineNumbers(on) {
      view.dispatch({ effects: linesCompartment.reconfigure(on ? lineNumbers() : []) });
    },
    setWrap(on) {
      view.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
    },
    destroy() {
      view.destroy();
    },
  };
}

export { EditorView, openSearchPanel };

// ---------------------------------------------------------------------------
// Format toolbar transforms (native Vditor toolbar parity, plan P1)
// ---------------------------------------------------------------------------

/** Wrap (or unwrap) the selection with before/after markers. */
export function wrapRange(view, before, after = before) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const text = state.sliceDoc(from, to);
  const wrapped = text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length;
  const inner = wrapped ? text.slice(before.length, text.length - after.length) : text;
  const insert = wrapped ? inner : before + inner + after;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + (wrapped ? 0 : before.length), head: from + (wrapped ? inner.length : before.length + inner.length) },
  });
}

/** Toggle a line prefix across the selected lines (list/quote/task). */
export function toggleLinePrefixes(view, prefix) {
  const { state } = view;
  const first = state.doc.lineAt(state.selection.main.from);
  const last = state.doc.lineAt(state.selection.main.to);
  const lines = [];
  for (let n = first.number; n <= last.number; n += 1) lines.push(state.doc.line(n));
  const allHave = lines.every((line) => line.text.trimStart().startsWith(prefix));
  const changes = lines.map((line) => {
    const at = line.text.search(/\S|$/);
    if (allHave) {
      const rest = line.text.slice(at).startsWith(prefix) ? line.text.slice(at + prefix.length) : line.text.slice(at);
      return { from: line.from + at, to: line.to, insert: rest };
    }
    return { from: line.from + at, to: line.to, insert: prefix + line.text.slice(at) };
  });
  view.dispatch({ changes });
}

/** Cycle the current line's heading level: none → # → ## → … → ###### → none. */
export function cycleHeading(view) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const match = /^(#{1,6})\s/.exec(line.text);
  const level = match ? match[1].length : 0;
  const stripped = match ? line.text.slice(match[0].length) : line.text;
  const insert = level >= 6 ? stripped : `${'#'.repeat(level + 1)} ${stripped}`;
  view.dispatch({ changes: { from: line.from, to: line.to, insert } });
}

/** Insert text at the selection (cursor lands at `cursorOffset` inside it). */
export function insertAtCursor(view, text, cursorOffset = text.length) {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + cursorOffset } });
  view.focus();
}

/** Insert a 3×3 markdown table template. */
export function insertTable(view) {
  insertAtCursor(view, '\n| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n|  |  |  |\n');
}

/** Wrap inline code, or fence the selection when it spans multiple lines. */
export function codeTransform(view) {
  const { state } = view;
  const { from, to } = state.selection.main;
  if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) {
    const text = state.sliceDoc(from, to);
    const fence = '```';
    view.dispatch({ changes: { from, to, insert: `\n${fence}\n${text}\n${fence}\n` } });
    return;
  }
  wrapRange(view, '`');
}
