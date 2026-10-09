import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMParser as PMDOMParser, Slice } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { findWrapping } from '@tiptap/pm/transform';
import {
  RT_BOX_LABELS,
  RT_COLOR_LABELS,
  RT_HIGHLIGHT_LABELS,
  RT_HIGHLIGHTS,
  RT_JUSTIFY,
  RT_TEXT_COLORS,
  isEmptyRichHtml,
  plainToEditorHtml,
  safeLinkHref,
  toEditorHtml,
  sanitizePastedHtml,
  sanitizeRichHtml,
  type RtBox,
  type RtHighlight,
  type RtTextColor,
} from '../../lib/richText';
import { useLeaveGuard } from './LeaveGuard';
import '../../styles/richText.css';

/* ---------- The three custom pieces (stored by name, never hex) ---------- */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    rtColor: {
      setRtColor: (color: RtTextColor) => ReturnType;
      unsetRtColor: () => ReturnType;
    };
    rtHighlight: {
      setRtHighlight: (hl: RtHighlight) => ReturnType;
      unsetRtHighlight: () => ReturnType;
    };
    rtBox: {
      toggleRtBox: (box: RtBox) => ReturnType;
      unsetRtBox: () => ReturnType;
    };
    rtAlign: {
      setRtAlign: (align: 'left' | 'justify') => ReturnType;
    };
  }
}

const RtColor = Mark.create({
  name: 'rtColor',
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-color'),
        renderHTML: (attrs: { color: string | null }) => (attrs.color ? { 'data-color': attrs.color } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-color]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setRtColor:
        (color: RtTextColor) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetRtColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

const RtHighlightMark = Mark.create({
  name: 'rtHighlight',
  addAttributes() {
    return {
      hl: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-hl'),
        renderHTML: (attrs: { hl: string | null }) => (attrs.hl ? { 'data-hl': attrs.hl } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'mark[data-hl]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setRtHighlight:
        (hl: RtHighlight) =>
        ({ commands }) =>
          commands.setMark(this.name, { hl }),
      unsetRtHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

const RtBoxNode = Node.create({
  name: 'rtBox',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      box: {
        default: 'tip',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-box'),
        renderHTML: (attrs: { box: string }) => ({ 'data-box': attrs.box }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-box]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0];
  },
  addCommands() {
    return {
      toggleRtBox:
        (box: RtBox) =>
        ({ state, tr, dispatch, commands }) => {
          // Inside a box already: the same kind takes the box away, another
          // kind changes it; otherwise exactly the selected lines (or the
          // line the cursor is on) go into a new box.
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const node = $from.node(depth);
            if (node.type.name === this.name) {
              return node.attrs.box === box ? commands.unsetRtBox() : commands.updateAttributes(this.name, { box });
            }
          }
          // Wrapped here on the transaction itself: a nested command would
          // still see the selection from before the lines were split.
          if (!dispatch) return true;
          splitSelectedLines(tr);
          const range = tr.selection.$from.blockRange(tr.selection.$to);
          const wrapping = range ? findWrapping(range, this.type, { box }) : null;
          if (!range || !wrapping) return false;
          tr.wrap(range, wrapping).scrollIntoView();
          return true;
        },
      unsetRtBox:
        () =>
        ({ state, tr, dispatch }) => {
          // The whole box goes; its text stays exactly as it is.
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const node = $from.node(depth);
            if (node.type.name === this.name) {
              if (dispatch) {
                const pos = $from.before(depth);
                tr.replaceWith(pos, pos + node.nodeSize, node.content);
              }
              return true;
            }
          }
          return false;
        },
    };
  },
});

/**
 * Fix (rich-text editor) Part 2: a paragraph with line breaks (Shift+Enter)
 * is split where the selected lines start and end, so a box or Justify takes
 * exactly those lines and not the whole paragraph.
 */
function splitSelectedLines(tr: Transaction): void {
  let { from, to } = tr.selection;
  let changed = false;
  // The end first, so the start does not move. The selection stays before
  // the new end split and after the new start split.
  const $to = tr.doc.resolve(to);
  if ($to.parent.isTextblock) {
    let endBreak = -1;
    $to.parent.forEach((child, offset) => {
      const pos = $to.start() + offset;
      if (endBreak < 0 && child.type.name === 'hardBreak' && pos >= to) endBreak = pos;
    });
    if (endBreak >= 0) {
      const step = tr.steps.length;
      tr.delete(endBreak, endBreak + 1).split(endBreak);
      const mapping = tr.mapping.slice(step);
      from = mapping.map(from, -1);
      to = mapping.map(to, -1);
      changed = true;
    }
  }
  const $from = tr.doc.resolve(from);
  if ($from.parent.isTextblock) {
    let startBreak = -1;
    $from.parent.forEach((child, offset) => {
      const pos = $from.start() + offset;
      if (child.type.name === 'hardBreak' && pos + 1 <= from) startBreak = pos;
    });
    if (startBreak >= 0) {
      const step = tr.steps.length;
      tr.delete(startBreak, startBreak + 1).split(startBreak);
      const mapping = tr.mapping.slice(step);
      from = mapping.map(from, 1);
      to = mapping.map(to, 1);
      changed = true;
    }
  }
  if (changed) tr.setSelection(TextSelection.create(tr.doc, from, to));
}

/** Fix Part 4: Left (normal) or Justify, stored as data-align="justify". */
const RtAlign = Extension.create({
  name: 'rtAlign',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          align: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute('data-align') === RT_JUSTIFY ? RT_JUSTIFY : null),
            renderHTML: (attrs: { align?: string | null }) => (attrs.align === RT_JUSTIFY ? { 'data-align': RT_JUSTIFY } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setRtAlign:
        (align: 'left' | 'justify') =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          splitSelectedLines(tr);
          const value = align === 'justify' ? RT_JUSTIFY : null;
          const { from, to } = tr.selection;
          tr.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === 'paragraph' || node.type.name === 'heading') {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: value });
            }
          });
          return true;
        },
    };
  },
});

/** Everything the editor knows. Anything else (pasted Word styles, fonts,
 *  sizes, tables) is dropped by the editor itself, then by the allow-list. */
export function richTextExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [3] },
      code: false,
      codeBlock: false,
      blockquote: false,
      strike: false,
      horizontalRule: false,
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https'],
        defaultProtocol: 'https',
        isAllowedUri: (url) => safeLinkHref(url) !== null,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
      },
    }),
    RtColor,
    RtHighlightMark,
    RtBoxNode,
    RtAlign,
  ];
}

/* ---------- Icons (line, 24×24, currentColor) ---------- */

const ICONS: Record<string, ReactNode> = {
  bold: <path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z" />,
  italic: <path d="M14 5h-4M14 19h-4M14 5l-4 14" />,
  underline: <path d="M7 4v7a5 5 0 0010 0V4M5 20h14" />,
  heading: <path d="M6 5v14M18 5v14M6 12h12" />,
  bullet: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <circle cx="5" cy="6" r="1.2" />
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="5" cy="18" r="1.2" />
    </>
  ),
  numbered: <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M4 13.5a1.5 1.5 0 113 0L4 17h3" />,
  alignLeft: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  justify: <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
  colour: (
    <>
      <path d="M6 19l6-14 6 14M8.5 13h7" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  tip: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  benefits: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  unbox: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="3" strokeDasharray="3 2.5" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
    </>
  ),
  undo: <path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" />,
  redo: <path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2" />,
  clear: <path d="M6 18L18 6M8 6h10l-2 6M10 18H6" />,
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/* ---------- Toolbar ---------- */

function ToolButton({
  label,
  icon,
  active,
  onClick,
  disabled,
  testId,
}: {
  label: string;
  icon: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`rt-tool${active ? ' is-active' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active ?? undefined}
      disabled={disabled}
      data-testid={testId}
      // Keep the text selection: the button never takes focus from the editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const [panel, setPanel] = useState<'colour' | 'link' | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [linkError, setLinkError] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      heading: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      numbered: e.isActive('orderedList'),
      warning: e.isActive('rtBox', { box: 'warning' }),
      tip: e.isActive('rtBox', { box: 'tip' }),
      benefits: e.isActive('rtBox', { box: 'benefits' }),
      inBox: e.isActive('rtBox'),
      justify: e.isActive({ align: RT_JUSTIFY }),
      link: e.isActive('link'),
      colour: e.isActive('rtColor') || e.isActive('rtHighlight'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();

  const openLink = () => {
    setLinkInput((editor.getAttributes('link').href as string | undefined) ?? 'https://');
    setLinkError(false);
    setPanel(panel === 'link' ? null : 'link');
  };
  const applyLink = () => {
    if (linkInput.trim() === '' || linkInput.trim() === 'https://') {
      chain().extendMarkRange('link').unsetLink().run();
      setPanel(null);
      return;
    }
    const href = safeLinkHref(linkInput);
    if (!href) {
      setLinkError(true);
      return;
    }
    chain().extendMarkRange('link').setLink({ href }).run();
    setPanel(null);
  };

  return (
    <div className="rt-toolbar" role="toolbar" aria-label="Formatting">
      <div className="rt-toolbar__row">
        <ToolButton label="Bold" icon="bold" active={state.bold} onClick={() => chain().toggleBold().run()} testId="rt-bold" />
        <ToolButton label="Italic" icon="italic" active={state.italic} onClick={() => chain().toggleItalic().run()} testId="rt-italic" />
        <ToolButton label="Underline" icon="underline" active={state.underline} onClick={() => chain().toggleUnderline().run()} testId="rt-underline" />
        <span className="rt-toolbar__sep" aria-hidden="true" />
        <ToolButton label="Heading" icon="heading" active={state.heading} onClick={() => chain().toggleHeading({ level: 3 }).run()} testId="rt-heading" />
        <ToolButton label="Bullet list" icon="bullet" active={state.bullet} onClick={() => chain().toggleBulletList().run()} testId="rt-bullet" />
        <ToolButton label="Numbered list" icon="numbered" active={state.numbered} onClick={() => chain().toggleOrderedList().run()} testId="rt-numbered" />
        <ToolButton label="Align left" icon="alignLeft" active={!state.justify} onClick={() => chain().setRtAlign('left').run()} testId="rt-align-left" />
        <ToolButton label="Justify" icon="justify" active={state.justify} onClick={() => chain().setRtAlign('justify').run()} testId="rt-justify" />
        <span className="rt-toolbar__sep" aria-hidden="true" />
        <ToolButton label="Text colour and highlight" icon="colour" active={state.colour || panel === 'colour'} onClick={() => setPanel(panel === 'colour' ? null : 'colour')} testId="rt-colour" />
        <ToolButton label={RT_BOX_LABELS.warning} icon="warning" active={state.warning} onClick={() => chain().toggleRtBox('warning').run()} testId="rt-warning" />
        <ToolButton label={RT_BOX_LABELS.tip} icon="tip" active={state.tip} onClick={() => chain().toggleRtBox('tip').run()} testId="rt-tip" />
        <ToolButton label={RT_BOX_LABELS.benefits} icon="benefits" active={state.benefits} onClick={() => chain().toggleRtBox('benefits').run()} testId="rt-benefits" />
        <ToolButton label="Remove box" icon="unbox" disabled={!state.inBox} onClick={() => chain().unsetRtBox().run()} testId="rt-unbox" />
        <ToolButton label="Link" icon="link" active={state.link || panel === 'link'} onClick={openLink} testId="rt-link" />
        <span className="rt-toolbar__sep" aria-hidden="true" />
        <ToolButton label="Undo" icon="undo" disabled={!state.canUndo} onClick={() => chain().undo().run()} testId="rt-undo" />
        <ToolButton label="Redo" icon="redo" disabled={!state.canRedo} onClick={() => chain().redo().run()} testId="rt-redo" />
        <ToolButton
          label="Clear formatting"
          icon="clear"
          onClick={() => chain().unsetAllMarks().clearNodes().run()}
          testId="rt-clear"
        />
      </div>

      {panel === 'colour' && (
        <div className="rt-panel" data-testid="rt-colour-panel">
          <p className="rt-panel__title">Text colour</p>
          <div className="rt-panel__swatches">
            <button type="button" className="rt-swatch rt-swatch--none" aria-label="Normal text colour" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().unsetRtColor().run()} />
            {RT_TEXT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="rt-swatch"
                data-color={c}
                aria-label={RT_COLOR_LABELS[c]}
                title={RT_COLOR_LABELS[c]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chain().setRtColor(c).run()}
              />
            ))}
          </div>
          <p className="rt-panel__title">Highlight</p>
          <div className="rt-panel__swatches">
            <button type="button" className="rt-swatch rt-swatch--none" aria-label="No highlight" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().unsetRtHighlight().run()} />
            {RT_HIGHLIGHTS.map((h) => (
              <button
                key={h}
                type="button"
                className="rt-swatch rt-swatch--hl"
                data-hl={h}
                aria-label={`${RT_HIGHLIGHT_LABELS[h]} highlight`}
                title={RT_HIGHLIGHT_LABELS[h]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chain().setRtHighlight(h).run()}
              />
            ))}
          </div>
          <p className="rt-panel__hint">Only these colours, so every product looks neat in light and dark mode.</p>
        </div>
      )}

      {panel === 'link' && (
        <div className="rt-panel rt-panel--link">
          <label className="rt-panel__title" htmlFor="rt-link-input">
            Link (http or https)
          </label>
          <div className="rt-panel__link-row">
            <input
              id="rt-link-input"
              className="form-input"
              type="url"
              inputMode="url"
              value={linkInput}
              onChange={(e) => {
                setLinkInput(e.target.value);
                setLinkError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink();
                }
              }}
            />
            <button type="button" className="adm-btn adm-btn--sm" onClick={applyLink}>
              Apply
            </button>
          </div>
          {linkError && <p className="rt-panel__error">Only http:// or https:// links.</p>}
        </div>
      )}
    </div>
  );
}

/* ---------- The field ---------- */

export interface RichTextEditorProps {
  id: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  labelledBy?: string;
  /** Which record the text belongs to (the product id). A new key always
   *  loads the new value, even over typing. */
  resetKey?: string;
  /** Called once the editor exists and shows the value. */
  onReady?: () => void;
}

/**
 * Batch 36 Part 2: the Word-like editor for long product text. Old plain
 * text opens as paragraphs but is only saved as rich text once it is
 * actually edited — opening and leaving changes nothing.
 */
export default function RichTextEditor({ id, value, onChange, placeholder, labelledBy, resetKey, onReady }: RichTextEditorProps) {
  const { markDirty } = useLeaveGuard();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // The value the editor shows right now (loaded or typed), so a value
  // coming from outside (the product arriving after the editor opened) can
  // be told apart from the editor's own echo.
  const shownValueRef = useRef(value);
  const resetKeyRef = useRef(resetKey);
  const typedRef = useRef(false);
  // Empty state class for the placeholder.
  const [empty, setEmpty] = useState(value.trim() === '');

  const editor = useEditor({
    extensions: richTextExtensions(),
    content: toEditorHtml(value),
    editorProps: {
      attributes: {
        id,
        class: 'rich-text rt-editor__content',
        role: 'textbox',
        'aria-multiline': 'true',
        ...(labelledBy ? { 'aria-labelledby': labelledBy } : {}),
        ...(placeholder ? { 'data-placeholder': placeholder } : {}),
      },
      // Pasting from Word / Google Docs / WhatsApp: only allowed formatting.
      transformPastedHTML: (html) => sanitizePastedHtml(html),
      // Fix Part 2: pasted plain text (WhatsApp, Notes): every line is its
      // own line and blank lines are kept, as they would be in the old text.
      clipboardTextParser: (text, $context, _plain, view) => {
        const dom = document.createElement('div');
        dom.innerHTML = plainToEditorHtml(text);
        const parsed = PMDOMParser.fromSchema(view.state.schema).parseSlice(dom, { preserveWhitespace: true, context: $context });
        return Slice.maxOpen(parsed.content);
      },
    },
    onUpdate: ({ editor: e }) => {
      typedRef.current = true;
      markDirty();
      const html = e.getHTML();
      const next = isEmptyRichHtml(html) ? '' : sanitizeRichHtml(html);
      shownValueRef.current = next;
      onChangeRef.current(next);
    },
  });

  // Fix (rich-text editor) Part 1: Tiptap only reads `content` when it is
  // created, so text that arrives later (the product loading after the
  // editor opened) is put in here — never as an undo step, never marking
  // the form as changed, and never over what is being typed (unless it is
  // another product).
  useEffect(() => {
    if (!editor) return;
    const keyChanged = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    if (keyChanged) typedRef.current = false;
    if (!keyChanged && (value === shownValueRef.current || typedRef.current)) return;
    shownValueRef.current = value;
    editor.chain().setMeta('addToHistory', false).setContent(toEditorHtml(value), { emitUpdate: false }).run();
    setEmpty(editor.isEmpty);
  }, [editor, value, resetKey]);

  useEffect(() => {
    if (editor) onReadyRef.current?.();
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const update = () => setEmpty(editor.isEmpty);
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);

  if (!editor) return null;
  return (
    <div className={`rt-editor${empty ? ' is-empty' : ''}`} data-testid={`rt-editor-${id}`}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
