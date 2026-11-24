import type { useRouter } from 'expo-router';

// Open a record: editor page, or a page dedicated to a single record (D-342).

export function openEditor(
  router: ReturnType<typeof useRouter>,
  collectionId: string,
  recordId?: string,
) {
  router.push({
    pathname: '/record/[collectionId]',
    params: recordId ? { collectionId, recordId } : { collectionId },
  });
}

/** Tap a record: when opens is a page ID, open the page dedicated to that record (D-342); when opens is "record" or omitted, open the editor page. */
export function openRow(
  router: ReturnType<typeof useRouter>,
  opens: string | undefined,
  collectionId: string,
  recordId: string,
) {
  if (opens !== undefined && opens !== 'record')
    router.push({ pathname: '/page/[pageId]', params: { pageId: opens, record: recordId } });
  else openEditor(router, collectionId, recordId);
}
