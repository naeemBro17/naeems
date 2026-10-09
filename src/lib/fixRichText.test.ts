import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Editor } from '@tiptap/core';
import { richTextExtensions } from '../components/admin/RichTextEditor';
import { INVOICE_FONT_FILES } from './invoice/invoiceFonts';
import {
  cleanLongText,
  emptiedLongTexts,
  plainToEditorHtml,
  sanitizePastedHtml,
  sanitizeRichHtml,
  splitLineBreaks,
  toEditorHtml,
} from './richText';

// Fix (rich-text editor): one line per paragraph, boxes on the selected
// lines only, Justify, no gap on Enter, Noto Sans Bengali.

function editorWith(html: string): Editor {
  return new Editor({ extensions: richTextExtensions(), content: html });
}

describe('Part 2: one line per paragraph', () => {
  it('line breaks become paragraphs; formatting over a break is kept on both sides', () => {
    expect(splitLineBreaks('<p>a<br><strong>b<br>c</strong></p>')).toBe(
      '<p>a</p><p><strong>b</strong></p><p><strong>c</strong></p>'
    );
  });

  it('a break that ends a paragraph shows nothing, so it adds no line; two keep one empty line', () => {
    expect(splitLineBreaks('<p>a<br></p>')).toBe('<p>a</p>');
    expect(splitLineBreaks('<p>a<br><br></p>')).toBe('<p>a</p><p></p>');
    expect(splitLineBreaks('<p>a<br><br>b</p>')).toBe('<p>a</p><p></p><p>b</p>');
  });

  it('old saved rich text opens as lines; old plain text keeps its blank lines', () => {
    expect(toEditorHtml('<p>one<br>two</p><div data-box="tip"><p>x<br>y</p></div>')).toBe(
      '<p>one</p><p>two</p><div data-box="tip"><p>x</p><p>y</p></div>'
    );
    expect(toEditorHtml('first\n\nsecond\r\nthird')).toBe('<p>first</p><p></p><p>second</p><p>third</p>');
    expect(plainToEditorHtml('')).toBe('<p></p>');
  });

  it('pasted HTML with line breaks becomes one paragraph per line', () => {
    expect(sanitizePastedHtml('<p>Line 1<br>Line <b>2</b></p>')).toBe('<p>Line 1</p><p>Line <b>2</b></p>');
  });

  it('a box wraps exactly the selected line, not the whole paragraph', () => {
    const editor = editorWith('<p>one<br>two<br>three</p>');
    // "two" sits between the two line breaks.
    editor.chain().setTextSelection({ from: 5, to: 8 }).toggleRtBox('warning').run();
    expect(editor.getHTML()).toBe('<p>one</p><div data-box="warning"><p>two</p></div><p>three</p>');
    editor.destroy();
  });

  it('no selection: only the line with the cursor', () => {
    const editor = editorWith('<p>one</p><p>two</p><p>three</p>');
    editor.chain().setTextSelection(7).toggleRtBox('tip').run();
    expect(editor.getHTML()).toBe('<p>one</p><div data-box="tip"><p>two</p></div><p>three</p>');
    editor.destroy();
  });

  it('Remove box (and the same box button) takes the whole box away, text unchanged', () => {
    const start = '<p>a</p><div data-box="warning"><p>b</p><p>c</p></div><p>d</p>';
    const editor = editorWith(start);
    editor.chain().setTextSelection(6).unsetRtBox().run();
    expect(editor.getHTML()).toBe('<p>a</p><p>b</p><p>c</p><p>d</p>');
    editor.commands.setContent(start);
    editor.chain().setTextSelection(9).toggleRtBox('warning').run();
    expect(editor.getHTML()).toBe('<p>a</p><p>b</p><p>c</p><p>d</p>');
    editor.destroy();
  });
});

describe('Part 4: Justify', () => {
  it('applies to the selected line only and survives the allow-list', () => {
    const editor = editorWith('<p>one<br>two</p>');
    editor.chain().setTextSelection(6).setRtAlign('justify').run();
    const html = editor.getHTML();
    expect(html).toBe('<p>one</p><p data-align="justify">two</p>');
    expect(sanitizeRichHtml(html)).toBe(html);
    editor.chain().setTextSelection(6).setRtAlign('left').run();
    expect(editor.getHTML()).toBe('<p>one</p><p>two</p>');
    editor.destroy();
  });

  it('the allow-list keeps only data-align="justify", only on p / h3', () => {
    expect(sanitizeRichHtml('<p data-align="center">a</p>')).toBe('<p>a</p>');
    expect(sanitizeRichHtml('<span data-align="justify">a</span>')).toBe('<span>a</span>');
    expect(sanitizeRichHtml('<h3 data-align="justify">a</h3>')).toBe('<h3 data-align="justify">a</h3>');
    expect(sanitizeRichHtml('<p style="text-align:justify">a</p>')).toBe('<p>a</p>');
  });
});

describe('Part 5: no gap on Enter', () => {
  it('an empty line in the middle is saved (not stripped)', () => {
    expect(cleanLongText('<p>a</p><p></p><p>b</p>')).toBe('<p>a</p><p></p><p>b</p>');
  });

  it('paragraphs have no margin; an empty paragraph keeps its height; same line height as the old text', () => {
    const css = readFileSync('src/styles/richText.css', 'utf8');
    expect(css).toMatch(/\.rich-text p \{\s*margin: 0;\s*\}/);
    expect(css).toMatch(/\.rich-text p:empty::before \{\s*content: '\\200b';/);
    expect(css).toMatch(/\.accordion__rich \{\s*font-size: 13\.5px;\s*line-height: 1\.7;/);
  });
});

describe('Part 1: asking before a text is saved empty', () => {
  const saved = { description: 'Old words', how_to_use: null, key_ingredients: '<p>Niacinamide</p>' };
  it('names the text that had words and would now be empty', () => {
    expect(emptiedLongTexts(saved, { description: '', how_to_use: '', key_ingredients: '<p>Niacinamide</p>' })).toEqual(['Description']);
    expect(emptiedLongTexts(saved, { description: 'Old words', how_to_use: '', key_ingredients: '<p></p>' })).toEqual(['Key Ingredients']);
  });
  it('nothing to ask for a new product or unchanged texts', () => {
    expect(emptiedLongTexts(null, { description: '', how_to_use: '', key_ingredients: '' })).toEqual([]);
    expect(emptiedLongTexts(saved, { description: 'Old words', how_to_use: '', key_ingredients: '<p>Niacinamide</p>' })).toEqual([]);
  });
});

describe('Part 6: Noto Sans Bengali', () => {
  it('the site and the invoice use Noto Sans Bengali, not Hind Siliguri', () => {
    const tokens = readFileSync('src/styles/tokens.css', 'utf8');
    const html = readFileSync('index.html', 'utf8');
    expect(tokens).toContain("--font-price:    'Plus Jakarta Sans', 'Noto Sans Bengali'");
    expect(tokens).toContain("--font-sans:     'Plus Jakarta Sans', 'Noto Sans Bengali'");
    expect(html).toContain('family=Noto+Sans+Bengali:wght@400;600;700');
    expect(`${tokens}${html}${readFileSync('src/styles/richText.css', 'utf8')}`).not.toMatch(/Hind/);
    expect(Object.values(INVOICE_FONT_FILES.bengali).every((file) => file.startsWith('NotoSansBengali-'))).toBe(true);
  });
});
