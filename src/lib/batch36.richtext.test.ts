import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import { richTextExtensions } from '../components/admin/RichTextEditor';
import { RichTextView } from '../components/shared/RichTextView';
import {
  LINK_REL,
  RT_HIGHLIGHTS,
  RT_TEXT_COLORS,
  cleanLongText,
  isRichText,
  plainToEditorHtml,
  richTextToPlain,
  sanitizePastedHtml,
  sanitizeRichHtml,
} from './richText';

// Batch 36 Part 2: rich product text.

// @ts-expect-error -- React reads this global to allow act() in tests.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function editorWith(html: string): Editor {
  return new Editor({ extensions: richTextExtensions(), content: html });
}

describe('toolbar actions produce only the allowed HTML', () => {
  const cases: [string, (e: Editor) => void, RegExp][] = [
    ['Bold', (e) => e.chain().selectAll().toggleBold().run(), /<strong>/],
    ['Italic', (e) => e.chain().selectAll().toggleItalic().run(), /<em>/],
    ['Underline', (e) => e.chain().selectAll().toggleUnderline().run(), /<u>/],
    ['Heading', (e) => e.chain().selectAll().toggleHeading({ level: 3 }).run(), /<h3>/],
    ['Bullet list', (e) => e.chain().selectAll().toggleBulletList().run(), /<ul><li><p>/],
    ['Numbered list', (e) => e.chain().selectAll().toggleOrderedList().run(), /<ol><li><p>/],
    ['Text colour', (e) => e.chain().selectAll().setRtColor('teal').run(), /<span data-color="teal">/],
    ['Highlight', (e) => e.chain().selectAll().setRtHighlight('mint').run(), /<mark data-hl="mint">/],
    ['Warning box', (e) => e.chain().selectAll().toggleRtBox('warning').run(), /<div data-box="warning"><p>/],
    ['Tip box', (e) => e.chain().selectAll().toggleRtBox('tip').run(), /<div data-box="tip"><p>/],
    ['Key benefits box', (e) => e.chain().selectAll().toggleRtBox('benefits').run(), /<div data-box="benefits"><p>/],
    ['Link', (e) => e.chain().selectAll().setLink({ href: 'https://naeems.com' }).run(), /<a [^>]*href="https:\/\/naeems\.com"/],
  ];
  for (const [name, act1, expected] of cases) {
    it(name, () => {
      const editor = editorWith('<p>খুশকির মূল কারণ</p>');
      act1(editor);
      const html = editor.getHTML();
      expect(html).toMatch(expected);
      // Everything the editor makes survives the allow-list unchanged
      // (links only gain their safe target/rel).
      expect(sanitizeRichHtml(html).replace(/ target="_blank"| rel="[^"]*"/g, '')).toBe(
        html.replace(/ target="_blank"| rel="[^"]*"/g, '')
      );
      editor.destroy();
    });
  }

  it('box toggles off again, clear formatting removes marks', () => {
    const editor = editorWith('<p>tip</p>');
    editor.chain().setTextSelection(2).toggleRtBox('tip').run();
    // The editor keeps an empty line after a box to type on; saving drops it.
    expect(editor.getHTML()).toBe('<div data-box="tip"><p>tip</p></div><p></p>');
    expect(cleanLongText(editor.getHTML())).toBe('<div data-box="tip"><p>tip</p></div>');
    // The cursor inside the box: Warning changes it, Warning again removes it.
    editor.chain().setTextSelection(3).toggleRtBox('warning').run();
    expect(cleanLongText(editor.getHTML())).toBe('<div data-box="warning"><p>tip</p></div>');
    editor.chain().setTextSelection(3).toggleRtBox('warning').run();
    expect(cleanLongText(editor.getHTML())).toBe('<p>tip</p>');
    editor.chain().selectAll().toggleBold().setRtColor('red').run();
    editor.chain().selectAll().unsetAllMarks().clearNodes().run();
    expect(cleanLongText(editor.getHTML())).toBe('<p>tip</p>');
    editor.destroy();
  });

  it('a javascript: link is refused by the editor', () => {
    const editor = editorWith('<p>x</p>');
    editor.chain().selectAll().setLink({ href: 'javascript:alert(1)' }).run();
    expect(editor.getHTML()).not.toContain('javascript');
    editor.destroy();
  });
});

describe('the allow-list (on save and on render)', () => {
  it('strips script, on* handlers, style and unknown tags; keeps their text', () => {
    const dirty =
      '<p onclick="steal()" style="color:red">Hi <script>alert(1)</script><font face="x">there</font>' +
      '<img src=x onerror="alert(1)"><table><tr><td>cell</td></tr></table></p>' +
      '<iframe src="https://evil"></iframe><span data-color="hotpink">pink</span><mark data-hl="red">m</mark>';
    const clean = sanitizeRichHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|style=|<font|<img|<table|<iframe|hotpink|data-hl="red"/);
    expect(clean).toContain('there');
    expect(clean).toContain('cell');
    expect(clean).toContain('<span>pink</span>');
  });

  it('links: http/https only, new tab, rel noopener noreferrer nofollow', () => {
    const clean = sanitizeRichHtml('<p><a href="https://naeems.com">ok</a> <a href="javascript:alert(1)">bad</a> <a href="data:text/html,x">bad2</a></p>');
    expect(clean).toContain(`<a href="https://naeems.com" target="_blank" rel="${LINK_REL}">ok</a>`);
    expect(clean).not.toContain('javascript');
    expect(clean).not.toContain('data:');
  });

  it('pasted Word / Google Docs HTML keeps only allowed formatting', () => {
    const word =
      '<p class="MsoNormal" style="mso-line-height:1"><b style="font-size:20pt">Bold</b> <span style="color:#ff0000;font-family:Arial">red</span></p>';
    const editor = editorWith(sanitizePastedHtml(word));
    expect(editor.getHTML()).toBe('<p><strong>Bold</strong> red</p>');
    editor.destroy();
    // Google Docs wraps everything in a "not bold" <b>.
    const docs = '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">Bold</span> plain</p></b>';
    const fromDocs = editorWith(sanitizePastedHtml(docs));
    expect(fromDocs.getHTML()).toBe('<p><strong>Bold</strong> plain</p>');
    fromDocs.destroy();
  });

  it('saving: rich is cleaned, plain stays as typed, empty is null', () => {
    expect(cleanLongText('  line one\nline two  ')).toBe('line one\nline two');
    expect(cleanLongText('<p>a<script>x</script></p>')).toBe('<p>a</p>');
    expect(cleanLongText('<p></p>')).toBeNull();
    expect(cleanLongText('   ')).toBeNull();
  });
});

describe('old plain text keeps working', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  it('is not rich, renders exactly as before (one <p class="accordion__text">, line breaks kept)', () => {
    const old = 'চুল ও স্ক্যাল্প ভালোভাবে ভিজিয়ে নিন।\n<b>not a tag</b>\n\nদিনে একবার';
    expect(isRichText(old)).toBe(false);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(createElement(RichTextView, { value: old })));
    const p = host.querySelector('p.accordion__text');
    expect(p?.textContent).toBe(old);
    expect(host.querySelector('b')).toBeNull();
  });

  it('rich text renders with its boxes, cleaned again', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const html = '<div data-box="benefits"><ul><li><p>a</p></li></ul></div><div data-box="warning"><p>w</p></div><p onclick="x()">t</p>';
    act(() => root?.render(createElement(RichTextView, { value: html })));
    expect(host.querySelector('.rich-text div[data-box="benefits"] li')).not.toBeNull();
    expect(host.querySelector('.rich-text div[data-box="warning"]')).not.toBeNull();
    expect(host.innerHTML).not.toContain('onclick');
  });

  // Changed by the rich-text editor fix (Parts 2 and 5): one paragraph per
  // line and an empty paragraph per blank line, now that paragraphs have no
  // gap between them.
  it('opening old text in the editor makes the same lines', () => {
    expect(plainToEditorHtml('a\nb\n\nc <d>')).toBe('<p>a</p><p>b</p><p></p><p>c &lt;d&gt;</p>');
  });

  it('meta description / link previews use plain text', () => {
    expect(richTextToPlain('<div data-box="benefits"><ul><li><p>খুশকি <strong>দূর</strong></p></li></ul></div><p>A &amp; B</p>')).toBe(
      'খুশকি দূর A & B'
    );
    expect(richTextToPlain('plain\ntext')).toBe('plain text');
  });
});

/* ---------- Colours: named, readable in light and dark ---------- */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--rt-([a-z-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2];
  return out;
}

describe('named colours are readable in light and dark mode', () => {
  const css = readFileSync('src/styles/richText.css', 'utf8');
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf("}", css.indexOf(':root {'))));
  const darkStart = css.indexOf(":root[data-theme='dark'] {");
  const dark = tokens(css.slice(darkStart, css.indexOf('}', darkStart)));

  it('every name has a light and a dark shade', () => {
    for (const c of RT_TEXT_COLORS) {
      expect(light[c]).toBeDefined();
      expect(dark[c]).toBeDefined();
    }
    for (const h of RT_HIGHLIGHTS) {
      expect(light[`hl-${h}`]).toBeDefined();
      expect(dark[`hl-${h}`]).toBeDefined();
    }
  });

  it('text colours: at least 4.5:1 on the light and dark page backgrounds', () => {
    for (const c of RT_TEXT_COLORS) {
      for (const bg of ['#ffffff', '#f2f2f7']) expect(contrast(light[c], bg), `${c} light on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const bg of ['#000000', '#1c1c1e']) expect(contrast(dark[c], bg), `${c} dark on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('highlights: the text on them is at least 4.5:1', () => {
    for (const h of RT_HIGHLIGHTS) {
      expect(contrast(light['hl-text'], light[`hl-${h}`]), `${h} light`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark['hl-text'], dark[`hl-${h}`]), `${h} dark`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
