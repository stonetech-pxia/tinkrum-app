import { formatValue, recordValue, type DataRecord, type LinkResolver } from './data';
import { fieldForRecord } from './money-currency';
import type { Collection, Locale } from './schema';

/** 用户写的占位符只替换一遍；值里的花括号不是新的模板，不解释表达式。 */
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
