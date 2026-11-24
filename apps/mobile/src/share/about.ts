import { mediaKindOf, type PlanAbout } from '@morph/core';

import { mimeOf } from '../runtime/actions/helpers';
import type { IncomingShare } from './incoming';

/** Only the shared file types and count are sent to the AI (D-124), without file names, sizes, or content. */
export function sharedAbout(share: IncomingShare): Extract<PlanAbout, { kind: 'shared' }> {
  let images = 0;
  let pdfs = 0;
  let videos = 0;
  let audio = 0;
  let others = 0;
  for (const f of share.files) {
    const kind = mediaKindOf(mimeOf(f.name, f.mimeType), f.name);
    if (kind === 'image') images++;
    else if (kind === 'pdf') pdfs++;
    else if (kind === 'video') videos++;
    else if (kind === 'audio') audio++;
    else others++;
  }
  return {
    kind: 'shared',
    images,
    pdfs,
    others,
    ...(videos ? { videos } : {}),
    ...(audio ? { audio } : {}),
  };
}
