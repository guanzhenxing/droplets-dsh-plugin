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
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
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
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(other) { return other.src === this.src && other.alt === this.alt; }
  toDOM() {
    const wrap = document.createElement('span');
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt ?? '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.style.maxWidth = '100%';
    img.style.borderRadius = '6px';
    img.addEventListener('error', () => {
      // Broken image: fall back to the raw text so nothing silently vanishes.
      wrap.textContent = `![${this.alt ?? ''}](${this.src})`;
    });
    wrap.appendChild(img);
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

/** [[wikilink]] and ![](image) line decorations (line-level regex pass). */
function linkDecorations(view, resolveImage) {
  const builder = new RangeSetBuilder();
  const caretLine = view.state.doc.lineAt(view.state.selection.main.from).number;
  const text = view.state.doc;
  const patterns = [
    { re: /!\[([^\]]*)\]\(([^)\s]+)\)/g, kind: 'image' },
    { re: /\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, kind: 'wikilink' },
  ];
  for (let n = 1; n <= text.lines; n += 1) {
    if (n === caretLine) continue;
    const line = text.line(n);
    for (const { re, kind } of patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line.text)) !== null) {
        if (kind === 'image') {
          const resolved = resolveImage(match[2]);
          if (resolved) {
            builder.add(line.from + match.index, line.from + match.index + match[0].length, Decoration.replace({ widget: new ImageWidget(resolved, match[1]) }));
          }
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
 * @param {(relativePath: string) => string|null} options.resolveImage
 * @param {Array} options.extraExtensions
 * @returns {{ view: EditorView, setDoc(text): void, setMode(mode): void, setLineNumbers(on): void, setWrap(on): void, destroy(): void }}
 */
export function createVaultEditor(parent, { doc = '', onChange, mode = 'live', lineNumbers: showLines = true, wrap = true, resolveImage, noteFiles = [], onWikilink, extraExtensions = [] } = {}) {
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

export { EditorView };
