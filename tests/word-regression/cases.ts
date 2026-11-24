// Regression test case list: one file per suite (pdfs/<suite>.pdf), located in cases/. Every time a
// Word conversion issue is fixed, add a page in pages/<suite>/ and an entry in the corresponding
// file (see README.md).
import type { Case } from './lib/case';
import { FONTS } from './cases/fonts';
import { FORMS } from './cases/forms';
import { GEOMETRY } from './cases/geometry';
import { GRAPHICS } from './cases/graphics';
import { NATIVE } from './cases/native';
import { TABLES } from './cases/tables';
import { TEXT_FLOW } from './cases/text-flow';

export const CASES: Case[] = [
  ...TEXT_FLOW,
  ...FORMS,
  ...TABLES,
  ...FONTS,
  ...GEOMETRY,
  ...GRAPHICS,
  ...NATIVE,
];
