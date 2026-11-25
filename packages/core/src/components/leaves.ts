import { z } from 'zod';

import { actionComponent } from './action';
import { appsComponent } from './apps';
import { buttonComponent } from './button';
import { calloutComponent } from './callout';
import { chartComponent } from './chart';
import { choicesComponent } from './choices';
import { dialComponent } from './dial';
import { dividerComponent } from './divider';
import { entryComponent } from './entry';
import { filesComponent } from './files';
import { formComponent } from './form';
import { headerComponent } from './header';
import { imageComponent } from './image';
import { libraryComponent } from './library';
import { noticeComponent } from './notice';
import { numberComponent } from './number';
import { packagesComponent } from './packages';
import { periodComponent } from './period';
import { pickerComponent } from './picker';
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
import { textComponent } from './text';

/** Appearances that can be placed inside groups (31 types, plus group itself makes 32 types; choices and period can only be on the page, validation bar; dial must be fixed at the bottom of the page, cannot enter groups, validation bar). New appearances are added at the end (the order matches the JSON Schema). */
export const LEAF_COMPONENTS = [
  headerComponent,
  textComponent,
  noticeComponent,
  imageComponent,
  dividerComponent,
  spacerComponent,
  buttonComponent,
  entryComponent,
  actionComponent,
  pickerComponent,
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
  libraryComponent,
  packagesComponent,
  singleComponent,
  dialComponent,
  periodComponent,
  tableComponent,
  galleryComponent,
  choicesComponent,
  calloutComponent,
  gridComponent,
  appsComponent,
] as const;

type Schemas<D extends readonly { schema: unknown }[]> = {
  -readonly [K in keyof D]: D[K]['schema'];
};

export const LeafComponentSchema = z.discriminatedUnion(
  'look',
  LEAF_COMPONENTS.map((d) => d.schema) as Schemas<typeof LEAF_COMPONENTS>,
);
