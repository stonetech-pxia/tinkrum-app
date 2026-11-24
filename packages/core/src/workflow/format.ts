import { formatNumber } from '../data';
import { localize } from '../localization';
import { t } from '../messages';
import { renderNameTemplate } from '../naming';
import type { Locale } from '../schema';
import { paramUnitLabel, type ActionDefinition, type ParamField } from './contract';

// Format parameter values into human-readable text (shared by change descriptions, workflow cards, and edit pages).

export function formatParamValue(
  field: ParamField,
  value: unknown,
  locale: Locale,
  now: Date,
): string {
  switch (field.kind) {
    case 'choice': {
      const option = field.options?.find((o) => o.value === value);
      return option ? localize(option.label, locale) : String(value);
    }
    case 'toggle':
      return value ? t(locale, 'format_on_7f2b0') : t(locale, 'format_off_4b193');
    case 'nameTemplate': {
      const template = String(value);
      const example = renderNameTemplate(template, {
        now,
        index: 1,
        sourceName: t(locale, 'format_report_25207'),
      });
      return template === example
        ? template
        : `${template}${t(locale, 'format_e_g_248d5', { v0: example })}`;
    }
    case 'number': {
      // French decimal separator is a comma (0,5).
      const shown =
        locale === 'fr' && typeof value === 'number'
          ? formatNumber(value, undefined, 'fr')
          : String(value);
      return field.unit ? `${shown} ${paramUnitLabel(field.unit, locale)}` : shown;
    }
    default:
      return String(value);
  }
}

/** Description of a set of parameters: "Target size 200 KB, Format JPEG". List only parameters that exist in fields and whose display conditions are met. */
export function describeParams(
  action: ActionDefinition,
  params: Record<string, unknown>,
  locale: Locale,
  now: Date,
  only?: readonly string[],
): string {
  const parts: string[] = [];
  for (const field of action.fields) {
    if (only && !only.includes(field.key)) continue;
    if (!(field.key in params)) continue;
    if (field.showIf && !field.showIf.equals.includes(params[field.showIf.key] as never)) continue;
    const value = field.private ? t(locale, 'format_your_text_6c667') : params[field.key];
    // When 0 has a special meaning (e.g., "at most 0 MB" actually means unlimited size): output only that phrase.
    if (field.zeroMeans && value === 0) {
      parts.push(localize(field.zeroMeans, locale));
      continue;
    }
    const label = localize(field.label, locale);
    const shown = formatParamValue(field, value, locale, now);
    // Option names form their own sentence ("Ask me"); when appended after a label, a colon is required to avoid reading like half a sentence.
    parts.push(
      field.kind === 'choice'
        ? t(locale, 'format_choice', { label, value: shown })
        : `${label} ${shown}`,
    );
  }
  return parts.join(t(locale, 'separatorList'));
}

/** Step name in lists: actions can adapt their wording based on parameters (e.g., calling it "Take photo" when the photo source is the camera). */
export function stepLabel(
  action: ActionDefinition | undefined,
  params: Record<string, unknown> | undefined,
  locale: Locale,
): string | undefined {
  if (!action) return undefined;
  return localize((params && action.labelFor?.(params)) ?? action.label, locale);
}
