import { describe, expect, it } from 'vitest';

import { extractFieldNames, fieldNameFromText, looksLikeValue } from './field-names';
import type { TextPage } from './rows';

const page = (lines: [string, number, number][], height = 16): TextPage => ({
  width: 800,
  height: 1100,
  lines: lines.map(([text, x, y]) => ({ text, x, y, width: text.length * 8, height })),
});

describe('extractFieldNames', () => {
  it('Colon: left side is the field name; do not split the entire segment', () => {
    expect(
      extractFieldNames([
        page([
          ['Date of birth: 12/03/1990', 40, 100],
          ['N° de facture : 88', 40, 150],
        ]),
      ]),
    ).toEqual(['Date of birth', 'N° de facture']);
  });
  it('Do not split even if there are unrecognized characters in the field name (OCR typos, symbols)', () => {
    expect(
      extractFieldNames([
        page([
          ['NumÃ©ro de contrat : CT-77120', 40, 100],
          ['Assur€ : Julien', 40, 150],
          ['Prix H.T. (€) : 12', 40, 200],
        ]),
      ]),
    ).toEqual(['NumÃ©ro de contrat', 'Assur€', 'Prix H.T. (€)']);
  });
  it('Find both sets of colons on the same line', () => {
    expect(extractFieldNames([page([['Inv No :KSB800  Date:11/03/18', 40, 100]])])).toEqual([
      'Inv No',
      'Date',
    ]);
  });
  it('Value is on the right; do not treat text values as field names', () => {
    const lines: [string, number, number][] = [
      ['Postal district', 40, 100],
      ['Northbridge', 380, 100],
      ['Registration date', 40, 195],
      ['16 April 2024', 380, 195],
      ['Annual fee', 40, 290],
      ['€240.50', 380, 290],
    ];
    expect(extractFieldNames([page(lines)])).toEqual([
      'Postal district',
      'Registration date',
      'Annual fee',
    ]);
  });
  it('Merge wrapped field names into one: value is on the second line or the first line', () => {
    const second: [string, number, number][] = [
      ['Member', 40, 100],
      ['reference', 40, 119],
      ['MB-4831', 400, 119],
      ['Full', 40, 195],
      ['name', 40, 214],
      ['Elena Voss', 400, 214],
    ];
    expect(extractFieldNames([page(second)])).toEqual(['Member reference', 'Full name']);
    const first: [string, number, number][] = [
      ['Date of birth of the', 40, 100],
      ['12/03/1990', 400, 100],
      ['insured person', 40, 119],
      ['Policy', 40, 195],
      ['AB-221', 400, 195],
    ];
    expect(extractFieldNames([page(first)])).toEqual([
      'Date of birth of the insured person',
      'Policy',
    ]);
  });
  it('Value is below; do not treat text values as field names', () => {
    const lines: [string, number, number][] = [
      ['Insurer', 40, 100],
      ['Bluecrest', 40, 120],
      ['Policy number', 40, 190],
      ['PL-22817', 40, 210],
      ['Vehicle make', 40, 280],
      ['Toyota', 40, 300],
    ];
    expect(extractFieldNames([page(lines)])).toEqual(['Insurer', 'Policy number', 'Vehicle make']);
  });
  it('Table: first row contains field names, wrap-around headers are merged by column', () => {
    const table: [string, number, number][] = [
      ['Item', 40, 100],
      ['Qty', 240, 100],
      ['Unit price', 440, 100],
      ['Soap', 40, 130],
      ['2', 240, 130],
      ['3.50', 440, 130],
      ['Rice', 40, 160],
      ['1', 240, 160],
      ['9.00', 440, 160],
    ];
    expect(extractFieldNames([page(table)])).toEqual(['Item', 'Qty', 'Unit price']);
  });
  it('Chinese is treated the same as languages without special handling (no dictionary used)', () => {
    expect(
      extractFieldNames([
        page([
          ['保单号码：BD-40917', 40, 100],
          ['Prémio anual: 344,90 €', 40, 150],
        ]),
      ]),
    ).toEqual(['保单号码', 'Prémio anual']);
  });
  it('Titles, full sentences, and values are not counted; do not guess when there is only a single line of text', () => {
    expect(
      extractFieldNames([
        page([
          ['Keep this page with your papers.', 40, 100],
          ['12 Main Street', 40, 200],
        ]),
      ]),
    ).toEqual([]);
    expect(extractFieldNames([])).toEqual([]);
  });
});

describe('fieldNameFromText', () => {
  it('Take the left side of the colon and remove fill-in lines', () => {
    expect(fieldNameFromText('Policy number: PL-1')).toBe('Policy number');
    expect(fieldNameFromText('Name ______')).toBe('Name');
  });
  it('Value validation', () => {
    expect(looksLikeValue('MB-4831')).toBe(true);
    expect(looksLikeValue('Address line 2')).toBe(false);
  });
});
