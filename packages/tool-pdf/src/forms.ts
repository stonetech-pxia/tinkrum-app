import {
  PDFCheckBox,
  PDFDropdown,
  type PDFField,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from 'pdf-lib';

import { PdfError, canEncodeStandardText, isEncodingError, loadPdf } from './core';

// Forms: list fields, fill (optionally flattening). Appearance is generated using the default
// pdf-lib Helvetica font, so the filled text must be encodable by standard fonts.

export type FormFieldType = 'text' | 'checkbox' | 'dropdown' | 'radio' | 'optionList' | 'other';

export interface FormField {
  name: string;
  type: FormFieldType;
  /** Text content / check state / selected option (takes the first when multi-selecting with optionList). */
  value?: string | boolean;
  options?: string[];
  multiline?: boolean;
  readOnly?: boolean;
}

function choice(
  base: { name: string; readOnly: boolean },
  type: FormFieldType,
  options: string[],
  selected: string | undefined,
): FormField {
  return { ...base, type, options, ...(selected !== undefined ? { value: selected } : {}) };
}

function describeField(field: PDFField): FormField {
  const base = { name: field.getName(), readOnly: field.isReadOnly() };
  if (field instanceof PDFTextField) {
    const text = field.getText();
    return {
      ...base,
      type: 'text',
      multiline: field.isMultiline(),
      ...(text !== undefined ? { value: text } : {}),
    };
  }
  if (field instanceof PDFCheckBox) return { ...base, type: 'checkbox', value: field.isChecked() };
  if (field instanceof PDFDropdown) {
    return choice(base, 'dropdown', field.getOptions(), field.getSelected()[0]);
  }
  if (field instanceof PDFRadioGroup) {
    return choice(base, 'radio', field.getOptions(), field.getSelected());
  }
  if (field instanceof PDFOptionList) {
    return choice(base, 'optionList', field.getOptions(), field.getSelected()[0]);
  }
  return { ...base, type: 'other' };
}

export async function listFormFields(bytes: Uint8Array): Promise<FormField[]> {
  const doc = await loadPdf(bytes);
  return doc.getForm().getFields().map(describeField);
}

/** Values must be renderable using standard fonts; multi-line text is checked line by line. */
function assertEncodable(text: string, name: string): void {
  if (!text.split(/\r\n|\r|\n/).every(canEncodeStandardText)) {
    throw new PdfError('unsupportedText', undefined, name);
  }
}

function setField(field: PDFField, value: string | boolean, name: string): void {
  const bad = () => new PdfError('badField', undefined, name);
  if (field.isReadOnly()) throw bad();
  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') throw bad();
    if (value) field.check();
    else field.uncheck();
    return;
  }
  if (typeof value !== 'string') throw bad();
  if (field instanceof PDFTextField) {
    assertEncodable(value, name);
    try {
      field.setText(value);
    } catch {
      throw bad(); // e.g. exceeding maxLength
    }
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    if (!field.getOptions().includes(value)) throw bad();
    assertEncodable(value, name);
    field.select(value);
  } else if (field instanceof PDFRadioGroup) {
    if (!field.getOptions().includes(value)) throw bad();
    field.select(value);
  } else {
    throw bad();
  }
}

/**
 * Fill by field name: strings for text / dropdown / radio / list, boolean for checkboxes. Missing
 * field, read-only, or mismatched value -> badField; unencodable text -> unsupportedText (both
 * include fieldName). When flatten is true, draws fields into the page and removes the form.
 */
export async function fillForm(
  bytes: Uint8Array,
  values: Readonly<Record<string, string | boolean>>,
  opts: { flatten: boolean },
): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) throw new PdfError('badField', undefined, name);
    setField(field, value, name);
  }
  try {
    if (opts.flatten) form.flatten();
    return await doc.save();
  } catch (e) {
    // Original non-WinAnsi text in unfilled fields will also fail when regenerating appearances.
    if (isEncodingError(e)) throw new PdfError('unsupportedText');
    throw e;
  }
}
