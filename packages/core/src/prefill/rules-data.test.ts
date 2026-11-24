import { describe, expect, it } from 'vitest';

import { TAX_WORD } from './rules-data';

// Tax keyword glossary (D-403): when there is no tax keyword in the entire text, unlabeled numbers
// are not treated as tax amounts. Newly added languages (Chinese, Japanese, Korean, Turkish,
// Portuguese, Arabic, Russian, Polish...) must not be treated as 'tax not specified' due to
// glossary omissions.

describe('TAX_WORD', () => {
  it.each([
    'Tax 3.20',
    'Sales tax',
    'VAT 20%',
    'TVA 10%',
    'MwSt 19%',
    'IVA incluido',
    'BTW 21%',
    'Imposta',
    '增值税',
    '消费税 8%',
    '消費税等',
    '稅額',
    '부가세 포함',
    '세금',
    'KDV %8',
    'TOPKDV 4,12',
    'VERGİ',
    'vergi no',
    'Imposto incluso',
    'ICMS 18%',
    'ضريبة',
    'الضريبة المضافة',
    'ض.ق.م',
    'НДС 20%',
    'налог',
    'PTU 23%',
    'podatek',
    'PPN 11%',
    'moms 25%',
    'ภาษีมูลค่าเพิ่ม',
  ])('Recognizes "%s"', (text) => {
    expect(TAX_WORD.test(text)).toBe(true);
  });

  it.each([
    'taxi to the airport',
    'relaxing',
    'ptuxyz',
    'Total 12.00',
    'thank you',
    '合计 43.20',
    '合計',
    'Итого',
  ])('Does not recognize "%s"', (text) => {
    expect(TAX_WORD.test(text)).toBe(false);
  });
});
