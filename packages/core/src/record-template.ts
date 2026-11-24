import { formatValue, recordValue, type DataRecord, type LinkResolver } from './data';
import { fieldForRecord } from './money-currency';
import type { Collection, Locale } from './schema';

/** Placeholders written by users are replaced only once; braces inside values are not new templates and do not evaluate expressions. */
export function fillRecordTemplate(
  template: string,
  collection: Collection,
  record: DataRecord,
  locale: Locale,
  links?: LinkResolver,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
    const fields = collection.fields.filter((f) => f.name === name);
    if (fields.length !== 1) {
      missing.add(name);
      return placeholder;
    }
    const f = fields[0]!;
    return formatValue(
      fieldForRecord(f, record.values, collection),
      recordValue(record, collection, f.id),
      locale,
      links,
    );
  });
  return { text, missing: [...missing] };
}
