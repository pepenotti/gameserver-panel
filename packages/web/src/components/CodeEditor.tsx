import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { javascript, json } from '@codemirror/legacy-modes/mode/javascript';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { Highlight, ParseIssue } from '@gsp/formats';

export interface CodeEditorHandle {
  /** Scroll to a line (1-based) and put the cursor there. */
  goTo(line: number, col?: number): void;
}

interface Props {
  value: string;
  onChange?: (v: string) => void;
  highlight: Highlight;
  readOnly?: boolean;
  height?: string;
  /** Problems to mark on their lines (hover shows the message). */
  issues?: ParseIssue[];
  ref?: Ref<CodeEditorHandle>;
}

// JSON5 has comments, bare keys and single quotes: the JavaScript mode reads those; plain JSON's would not.
const MODES: Record<Exclude<Highlight, 'plain'>, StreamParser<unknown>> = { properties, lua, yaml, toml, json, json5: javascript };

const setIssues = StateEffect.define<ParseIssue[]>();
const NO_ISSUES: ParseIssue[] = [];

function issueDecorations(state: EditorState, issues: ParseIssue[]): DecorationSet {
  const byLine = new Map<number, string[]>();
  for (const i of issues) if (i.line >= 1 && i.line <= state.doc.lines) byLine.set(i.line, [...(byLine.get(i.line) ?? []), i.message]);
  const b = new RangeSetBuilder<Decoration>();
  for (const line of [...byLine.keys()].sort((a, c) => a - c)) {
    const from = state.doc.line(line).from;
    b.add(from, from, Decoration.line({ class: 'cm-issue-line', attributes: { title: byLine.get(line)!.join('\n') } }));
  }
  return b.finish();
}

const issueField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setIssues)) next = issueDecorations(tr.state, e.value);
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Thin CodeMirror 6 wrapper: highlighting per format, search (Ctrl+F), undo history, issues marked on their lines. */
export function CodeEditor({ value, onChange, highlight, readOnly = false, height = '60vh', issues = NO_ISSUES, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const issuesRef = useRef(issues);
  issuesRef.current = issues;

  useImperativeHandle(ref, () => ({
    goTo(line, col = 1) {
      const v = view.current;
      if (!v || line < 1 || line > v.state.doc.lines) return;
      const l = v.state.doc.line(line);
      const pos = Math.min(l.from + Math.max(col - 1, 0), l.to);
      v.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      v.focus();
    },
  }));

  // CodeMirror joins lines with \n unless told otherwise: a CRLF file (written on Windows) must come back as CRLF.
  const [crlf] = useState(() => value.includes('\r\n'));

  useEffect(() => {
    if (!host.current) return;
    const language: Extension[] = highlight === 'plain' ? [] : [StreamLanguage.define(MODES[highlight])];
    if (crlf) language.push(EditorState.lineSeparator.of('\r\n'));
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          ...language,
          oneDark,
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          issueField,
          EditorView.theme({
            '&': { height, fontSize: '13px' },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-issue-line': { backgroundColor: 'rgba(250, 82, 82, 0.18)', boxShadow: 'inset 3px 0 0 #fa5252' },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changeRef.current?.(u.state.sliceDoc());
          }),
        ],
      }),
    });
    v.dispatch({ effects: setIssues.of(issuesRef.current) });
    view.current = v;
    return () => v.destroy();
    // Recreate only when the highlighting, mode or line ending changes; value and issues sync below.
  }, [highlight, readOnly, height, crlf]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.sliceDoc() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setIssues.of(issues) });
  }, [issues]);

  return <div ref={host} style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8, overflow: 'hidden' }} />;
}
