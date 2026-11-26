import { z } from 'zod';

import { buttonComponent } from './button';
import { catalogComponent } from './catalog';
import { chartComponent } from './chart';
import { dialComponent } from './dial';
import { filesComponent } from './files';
import { formComponent } from './form';
import { headerComponent } from './header';
import { imageComponent } from './image';
import { noticeComponent } from './notice';
import { numberComponent } from './number';
import {
  boardComponent,
  calendarComponent,
  cardsComponent,
  checklistComponent,
  galleryComponent,
  gridComponent,
  listComponent,
  tableComponent,
  tilesComponent,
} from './records';
import { singleComponent } from './single';
import { spacerComponent } from './spacer';
import { tabsComponent } from './tabs';
import { textComponent } from './text';

/** Appearances that can be placed inside groups (23 types, plus group itself makes 24 types; tabs can only be on the page, and dial must be fixed at the bottom of the page: the validator rejects them in a group). New appearances are added at the end (the order matches the JSON Schema). */
export const LEAF_COMPONENTS = [
  headerComponent,
  textComponent,
  noticeComponent,
  imageComponent,
  spacerComponent,
  buttonComponent,
  listComponent,
  cardsComponent,
  checklistComponent,
  tilesComponent,
  boardComponent,
  calendarComponent,
  numberComponent,
  chartComponent,
  formComponent,
  filesComponent,
  singleComponent,
  dialComponent,
  tableComponent,
  galleryComponent,
  gridComponent,
  catalogComponent,
  tabsComponent,
] as const;

type Schemas<D extends readonly { schema: unknown }[]> = {
  -readonly [K in keyof D]: D[K]['schema'];
};

export const LeafComponentSchema = z.discriminatedUnion(
  'look',
  LEAF_COMPONENTS.map((d) => d.schema) as Schemas<typeof LEAF_COMPONENTS>,
);
