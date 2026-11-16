import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { hiddenFormFields } from './data';
import { conditionProblems } from './conditions';
import { fieldDefinition, type Collection, type Condition } from './schema';

// 记录表单怎么排（D-570，创始人 2026-11-16 决定 ①）：表上的 form 只有分段和条件显示，字段上有提示（hint）和
// 范围（min / max）。保存、删除、附件、候选值和记录页别的部分仍归内核，记录页不变成自由页面。

export interface ShownSection {
  /** 段在 form.sections 里的位置；排在最后、没写进任何一段的那些字段是 null。 */
  index: number | null;
  title?: string;
  fields: string[];
  when?: Condition[];
}

/**
 * 表单的全部段：配置里的段按顺序（只留表里还有的字段），然后是没写进任何一段的字段（按表里的顺序，没有标题）。
 * 加了字段一定排得进来，不需要把每个字段都列出来。
 */
export function formSections(collection: Collection): ShownSection[] {
  const ids = new Set(collection.fields.map((f) => f.id));
  const placed = new Set<string>();
  const sections: ShownSection[] = [];
  (collection.form?.sections ?? []).forEach((s, index) => {
    const fields = s.fields.filter((id) => ids.has(id) && !placed.has(id));
    fields.forEach((id) => placed.add(id));
    if (fields.length === 0) return;
    sections.push({
      index,
      ...(s.title !== undefined ? { title: s.title } : {}),
      fields,
      ...(s.when ? { when: s.when } : {}),
    });
  });
  const rest = collection.fields.map((f) => f.id).filter((id) => !placed.has(id));
  if (rest.length > 0) sections.push({ index: null, fields: rest });
  return sections;
}

/**
 * 表单里现在的值（输入框里的文字、勾选……）宽容地换成存的值：写不进去的当作没有。条件显示按它判断，
 * 用户一边填一边变。
 */
function formStoredValues(
  collection: Collection,
  formValues: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of collection.fields) {
    const write = fieldDefinition(field.type).write;
    const raw = formValues[field.id];
    if (!write || raw === undefined || raw === null || raw === '') continue;
    const result = write(field, raw);
    if ('value' in result) out[field.id] = result.value;
  }
  return out;
}

/** 按表单里现在的值，这时显示的段（条件不成立的段不画）。 */
export function visibleFormSections(
  collection: Collection,
  formValues: Record<string, unknown>,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): ShownSection[] {
  const hidden = hiddenFormFields(collection, formStoredValues(collection, formValues), now, cal);
  return formSections(collection).filter((s) => !s.fields.some((id) => hidden.has(id)));
}

/**
 * 表单要交去保存的值：藏着的段里的字段不交（存着的值不动，新记录用默认值），用户在它藏起来之前改的也不算。
 * 这样藏着的字段不会因为看不见的错误挡住保存（底线 5：不清空任何值）。
 */
export function formInput(
  collection: Collection,
  formValues: Record<string, unknown>,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): Record<string, unknown> {
  const hidden = hiddenFormFields(collection, formStoredValues(collection, formValues), now, cal);
  if (hidden.size === 0) return formValues;
  return Object.fromEntries(Object.entries(formValues).filter(([id]) => !hidden.has(id)));
}

/**
 * 表单里改了值以后还留着的错误（D-572）：改了的字段，它的错误去掉（改对了没有，下一次保存再查）；别的字段的照旧。
 */
export function issuesLeft<I extends { fieldId: string }>(
  issues: readonly I[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): I[] {
  const left = issues.filter(
    (i) => JSON.stringify(before[i.fieldId]) === JSON.stringify(after[i.fieldId]),
  );
  return left.length === issues.length ? (issues as I[]) : left;
}

/** 表单分段的检查（validate.ts）：字段在表里、每个字段只在一段里；条件只看这一条自己填的字段，不看本段的字段。 */
export function entryFormProblems(collection: Collection): string[] {
  const sections = collection.form?.sections ?? [];
  const problems: string[] = [];
  const seen = new Set<string>();
  sections.forEach((s, i) => {
    const where = `table ${collection.id} form.sections[${i}]`;
    for (const id of s.fields) {
      if (!collection.fields.some((f) => f.id === id))
        problems.push(`${where}: ${id} is not a field of ${collection.id}`);
      else if (seen.has(id)) problems.push(`${where}: ${id} is already in another section`);
      seen.add(id);
    }
    for (const c of s.when ?? []) {
      const f = collection.fields.find((x) => x.id === c.field);
      if (s.fields.includes(c.field))
        problems.push(
          `${where}: when looks at ${c.field}, which is in this same section; a section can only depend on fields outside it`,
        );
      else if (
        c.field === 'createdAt' ||
        c.field === 'updatedAt' ||
        (f && !fieldDefinition(f.type).write)
      )
        problems.push(
          `${where}: when looks at ${c.field}, which is not filled in by the user; a section can only depend on fields filled in on this entry`,
        );
    }
    for (const p of conditionProblems(s.when, collection)) problems.push(`${where} when: ${p}`);
  });
  return problems;
}
