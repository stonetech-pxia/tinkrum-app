import { composePage } from './doc-compose';
import { finishPageMargins } from './doc-margins';
import { buildParagraphBlocks } from './doc-paragraphs';
import { preparePage } from './doc-prepare';
import { preservePageFigures } from './doc-preserve-figures';
import { assignPageRegions } from './doc-regions';
import { buildRuledTables } from './doc-ruled-tables';
import type { DocBuildOptions, DocPage, DocPageInput } from './doc-support';
import { prepareTextLines } from './doc-text-lines';
import { buildTextTables } from './doc-text-tables';
import { measurePageTypography } from './doc-typography';

/** Concatenate stages in original order; rebuild callbacks preserve the original full-page fallback path. */
export function buildPage(
  input: DocPageInput,
  options: DocBuildOptions,
  protectFigures: boolean,
  repairTables = true,
  repairBarcodes = true,
): DocPage {
  const base = { input, options, protectFigures, repairTables, repairBarcodes, buildPage };
  const prepared = preparePage(base);
  if ('done' in prepared) return prepared.done;
  const source = prepared.state;
  const ruledResult = buildRuledTables({ ...base, ...source });
  const ruled = ruledResult.state;
  const textResult = prepareTextLines({ ...source, ...ruled });
  const text = textResult.state;
  const detected = buildTextTables({ ...base, ...source, ...ruled, ...text });
  if ('done' in detected) return detected.done;
  const tables = detected.state;
  const assigned = assignPageRegions({ ...base, ...source, ...ruled, ...text, ...tables });
  if ('done' in assigned) return assigned.done;
  const regions = assigned.state;
  const typographyResult = measurePageTypography({
    ...base,
    ...source,
    ...ruled,
    ...text,
    ...tables,
    ...regions,
  });
  const typography = typographyResult.state;
  buildParagraphBlocks({ ...base, ...source, ...ruled, ...text, ...tables, ...typography });
  const composed = composePage({
    ...base,
    ...source,
    ...text,
    ...tables,
    ...regions,
    ...typography,
  });
  if ('done' in composed) return composed.done;
  const page = composed.state;
  const preserved = preservePageFigures({ ...source, ...page });
  if ('done' in preserved) return preserved.done;
  return finishPageMargins({ ...source, ...page });
}
