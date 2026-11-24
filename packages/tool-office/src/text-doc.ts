import type { DocDoc, DocParagraph } from './doc';

// Text to Word conversion (D-441): text string -> DocDoc (one page, blank lines separate
// paragraphs, line breaks within paragraphs are preserved), then passed to writeDocx to write as
// docx. There is no layout to speak of, so box and page dimensions are merely placeholders; body
// font size and font use docx defaults (sans-serif, East Asian fonts also written to every run).

const BODY_SIZE = 11;
const BOX = { x: 0, y: 0, width: 1, height: 1 };

/** Split paragraphs by blank lines; line breaks within paragraphs are preserved, trailing whitespace is removed from each line; text consisting entirely of whitespace has no paragraphs. */
export function textToDocDoc(text: string): DocDoc {
  const parts = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*(?:\n[ \t]*)+/)
    .map((part) =>
      part
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/^\n+|\n+$/g, ''),
    )
    .filter((part) => part.trim() !== '');
  const blocks: DocParagraph[] = parts.map((part, i) => ({
    kind: 'paragraph',
    text: part,
    ...(i > 0 ? { spaced: true } : {}),
    box: BOX,
  }));
  return {
    version: 1,
    pages: [{ source: '', width: 1000, height: 1400, bodySize: BODY_SIZE, blocks }],
  };
}
