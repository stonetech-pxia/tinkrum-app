import type { RunItem } from '@morph/core';

// Results of Excel or Word conversion (D-272, D-328): when intermediate formatting is present and
// preserved specifically for this file (subsequent steps did not generate a new file), the results
// page can "put it on the desk" to edit (file-room R2, D-366).

export const canEditTable = (item: RunItem) =>
  item.tableDoc !== undefined && item.tableDoc.for === item.uri;

export const canEditWord = (item: RunItem) =>
  item.docDoc !== undefined && item.docDoc.for === item.uri;
