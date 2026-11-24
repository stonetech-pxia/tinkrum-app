import { describe, expect, it } from 'vitest';

import { scanWorkflows } from './scan';

// D-450: Scanned files remain in the app's document library (decided by the founder in conversation on 2026-11-05): the final step of a scan-to-PDF built-in quick action saves to files.
describe('scan presets keep the result in the app', () => {
  it.each(['zh', 'en', 'fr'] as const)(
    'scan-camera and scan-library end with file.save (%s)',
    (locale) => {
      const flows = scanWorkflows(locale);
      for (const id of ['scan-camera', 'scan-library']) {
        const steps = flows.find((w) => w.id === id)!.steps;
        expect(steps.at(-1)!.action).toBe('file.save');
        // D-455: Includes a text layer so the document library can search by words inside the PDF.
        expect(steps.find((s) => s.action === 'pdf.fromImages')!.params).toMatchObject({
          textLayer: true,
        });
      }
    },
  );

  it('straightening photos does not make a document, so it does not save', () => {
    const steps = scanWorkflows('zh').find((w) => w.id === 'scan-straighten')!.steps;
    expect(steps.map((s) => s.action)).not.toContain('file.save');
  });
});
