import { strToU8, zipSync } from 'fflate';
import { decodeOfficeXml, OfficeImportFailure, openPackage } from './ooxml';
import { decodeEntities } from './xml';
import { escapeXml } from './xlsx';

// The original package only corrects body text, headers, and footers, without converting it to DocDoc, to avoid losing letterheads, styles, and tables.
interface TextPart {
  start: number;
  end: number;
  prefix: string;
  text: string;
}

export function fillWordXml(xml: string, fill: (text: string) => string): string {
  const prefixes = [
    ...xml.matchAll(
      /xmlns(?::([\w.-]+))?=["'](?:http:\/\/schemas.openxmlformats.org\/wordprocessingml\/2006\/main|http:\/\/purl.oclc.org\/ooxml\/wordprocessingml\/main)["']/g,
    ),
  ].map((m) => (m[1] ? `${m[1]}:` : ''));
  if (!prefixes.length) return xml;
  const groups: TextPart[][] = [];
  let parts: TextPart[] = [];
  const flush = () => {
    if (parts.length) groups.push(parts);
    parts = [];
  };
  const prefix = `(?:${prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
  // Paragraphs, line breaks, tabs, fields, and graphics are all boundaries; a placeholder cannot be spanned across these places.
  const tokens = new RegExp(
    `<(${prefix})t\\b[^>]*>([^<]*)<\\/\\1t>|<\\/?${prefix}(?:p|br|tab|cr|fldChar|instrText|drawing|pict)\\b[^>]*>`,
    'g',
  );
  for (const m of xml.matchAll(tokens)) {
    if (m[2] === undefined) {
      flush();
      continue;
    }
    parts.push({
      start: m.index!,
      end: m.index! + m[0].length,
      prefix: m[1]!,
      text: decodeEntities(m[2]),
    });
  }
  flush();
  const edits: { start: number; end: number; text: string }[] = [];
  for (const group of groups) {
    const joined = group.map((p) => p.text).join('');
    const values = group.map((p) => p.text);
    const offsets: number[] = [];
    let n = 0;
    for (const p of group) {
      offsets.push(n);
      n += p.text.length;
    }
    // Modify in reverse order so that the offsets of the original fragments remain unchanged; curly braces in the replacement values will not be read again.
    for (const m of [...joined.matchAll(/\{[^{}]+\}/g)].reverse()) {
      const replacement = fill(m[0]);
      if (replacement === m[0]) continue;
      const start = m.index!,
        end = start + m[0].length;
      const first = group.findIndex((p, i) => offsets[i]! + p.text.length > start);
      for (let i = first; i < group.length && offsets[i]! < end; i++) {
        const a = Math.max(0, start - offsets[i]!);
        const b = Math.min(group[i]!.text.length, end - offsets[i]!);
        values[i] = values[i]!.slice(0, a) + (i === first ? replacement : '') + values[i]!.slice(b);
      }
    }
    group.forEach((p, i) => {
      if (p.text === values[i]) return;
      const text = escapeXml(values[i]!).replace(
        /\r\n|\r|\n/g,
        `</${p.prefix}t><${p.prefix}br/><${p.prefix}t xml:space="preserve">`,
      );
      edits.push({
        start: p.start,
        end: p.end,
        text: `<${p.prefix}t xml:space="preserve">${text}</${p.prefix}t>`,
      });
    });
  }
  for (const e of edits.sort((a, b) => b.start - a.start))
    xml = xml.slice(0, e.start) + e.text + xml.slice(e.end);
  return xml;
}

export function fillDocxTemplate(bytes: Uint8Array, fill: (text: string) => string): Uint8Array {
  // openPackage checks compression ratio, single parts, and total size before extraction; all unmodified parts are preserved as-is.
  const pkg = openPackage(bytes, () => true);
  if (!pkg.names.some((n) => n.toLowerCase() === 'word/document.xml'))
    throw new OfficeImportFailure('notOffice');
  if (pkg.xml('word/document.xml')?.name !== 'w:document') throw new OfficeImportFailure('damaged');
  const files: Record<string, Uint8Array> = {};
  for (const name of pkg.names) {
    const data = pkg.bytes(name);
    if (!data) throw new OfficeImportFailure('damaged');
    files[name] = data;
    if (/^word\/.*\.xml$/i.test(name)) {
      const original = decodeOfficeXml(data);
      const filled = fillWordXml(original, fill);
      if (filled !== original)
        files[name] = strToU8(
          filled.replace(/^(<\?xml\b[^?]*encoding\s*=\s*["'])[^"']+(["'])/i, '$1UTF-8$2'),
        );
    }
  }
  return zipSync(files, { level: 6 });
}
