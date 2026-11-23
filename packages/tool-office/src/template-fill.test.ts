import { expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { fillDocxTemplate } from './template-fill';
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
it('fills split runs, tables and headers while preserving styling, relationships and images', () => {
  const doc = `<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{Na</w:t></w:r><w:r><w:t>me} tail</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>{Name}</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const files = {
    'word/document.xml': strToU8(doc),
    'word/header1.xml': strToU8(
      `<w:hdr xmlns:w="${ns}"><w:p><w:r><w:t>{Name}</w:t></w:r></w:p></w:hdr>`,
    ),
    'word/media/image.png': new Uint8Array([1, 2]),
    '_rels/.rels': strToU8(
      '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
  };
  const result = unzipSync(
    fillDocxTemplate(zipSync(files), (s) => s.replaceAll('{Name}', 'A & B\nC')),
  );
  const xml = strFromU8(result['word/document.xml']!);
  expect(xml).toContain('<w:b/>');
  expect(xml).toContain('A &amp; B</w:t><w:br/><w:t xml:space="preserve">C');
  expect(xml).toContain(' tail');
  expect(xml).not.toContain('{Na');
  expect(strFromU8(result['word/header1.xml']!)).toContain('A &amp; B');
  expect(result['word/media/image.png']).toEqual(files['word/media/image.png']);
});
it('does not join placeholders across paragraphs or line breaks', () => {
  const xml = `<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:t>{Na</w:t><w:br/><w:t>me}</w:t></w:r></w:p></w:body></w:document>`;
  const files = { 'word/document.xml': strToU8(xml) };
  const result = unzipSync(fillDocxTemplate(zipSync(files), (s) => s.replaceAll('{Name}', 'BAD')));
  expect(strFromU8(result['word/document.xml']!)).toBe(xml);
});
it('handles alternate namespace prefixes and multiple placeholders without interpreting replacement braces', () => {
  const xml = `<x:document xmlns:x="${ns}"><x:body><x:p><x:r><x:t>{A} / {B} / {A}</x:t></x:r></x:p></x:body></x:document>`;
  const result = unzipSync(
    fillDocxTemplate(zipSync({ 'word/document.xml': strToU8(xml) }), (s) =>
      s === '{A}' ? '{B}' : s === '{B}' ? 'Z' : s,
    ),
  );
  expect(strFromU8(result['word/document.xml']!)).toContain('{B} / Z / {B}');
});
it('writes UTF-8 declarations for edited UTF-16 XML and preserves untouched parts byte for byte', () => {
  const original = `<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:t>{Name}</w:t></w:r></w:p></w:body></w:document>`;
  const encoded = new Uint8Array(2 + original.length * 2);
  encoded[0] = 255;
  encoded[1] = 254;
  for (let i = 0; i < original.length; i++) {
    encoded[i * 2 + 2] = original.charCodeAt(i) & 255;
    encoded[i * 2 + 3] = original.charCodeAt(i) >> 8;
  }
  const untouched = strToU8('<w:styles xmlns:w="' + ns + '"><!-- keep me --></w:styles>');
  const result = unzipSync(
    fillDocxTemplate(zipSync({ 'word/document.xml': encoded, 'word/styles.xml': untouched }), (s) =>
      s.replace('{Name}', 'Zoé'),
    ),
  );
  expect(strFromU8(result['word/document.xml']!)).toContain('encoding="UTF-8"');
  expect(strFromU8(result['word/document.xml']!)).toContain('Zoé');
  expect(result['word/styles.xml']).toEqual(untouched);
});
