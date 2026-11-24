import { z } from 'zod';

import type { DescribeContext } from '../describe';
import type { WorkspaceConfig } from '../schema';
import type {
  CheckContext,
  CheckProblem,
  ComponentAI,
  ComponentEdit,
  ComponentRef,
  LookMeta,
} from './define';
import { valueAt } from './define';
import { groupComponent, InnerGroupSchema } from './group';
import { LEAF_COMPONENTS, LeafComponentSchema } from './leaves';

export * from './define';
export { GROUP_MAX_CHILDREN, GroupChildSchema, InnerGroupSchema } from './group';
export { LEAF_COMPONENTS, LeafComponentSchema } from './leaves';
export { entryKind, entryEditableText } from './entry';
export {
  RECORD_LOOKS,
  RECORD_LOOK_DOC,
  RecordSourceSchema,
  TrailingFormatSchema,
  type RecordLook,
  type RecordSource,
} from './records';
export { NumberSourceSchema, type NumberSource } from './number';
export { ChartSourceSchema, type ChartSource } from './chart';
export { SMART_DATE_TYPES } from './form';

/** All appearances: items nestable in groups, plus the group appearance itself. */
export const COMPONENTS = [...LEAF_COMPONENTS, groupComponent] as const;

export const ComponentSchema = z.discriminatedUnion('look', [
  ...LeafComponentSchema.options,
  groupComponent.schema,
]);

/** A marker symbol guaranteed not to equal any appearance name (represented as the original string at runtime). */
type UnknownLook = symbol & { readonly unknownLook: never };

/**
 * Blocks unrecognized by this app version (D-254): appearances added by newer apps, or
 * unrecognized components migrated from v33 (look "$unknown", raw contains original JSON, M8).
 * Preserved as-is when reading existing configs (written back as original JSON on save), displays
 * an "App update required" placeholder on screen, movable and deletable only; cannot be added or
 * modified by the AI. Runtime look is the original string; treated as a unique marker in types
 * and must be handled separately when checking appearances (isKnownComponent).
 */
export interface UnknownComponent {
  id: string;
  look: UnknownLook;
  hidden?: boolean;
}

/** Appearance migrated from unrecognized v33 components (M8). */
export const UNKNOWN_LOOK = '$unknown';

export type LeafComponent = z.infer<typeof LeafComponentSchema>;
export type InnerGroupComponent = Omit<z.infer<typeof InnerGroupSchema>, 'children'> & {
  children: (LeafComponent | UnknownComponent)[];
};
/** Groups may also contain unrecognized blocks (D-254) and nested group levels (Q3). */
export type GroupComponent = Omit<z.infer<typeof groupComponent.schema>, 'children'> & {
  children: (LeafComponent | InnerGroupComponent | UnknownComponent)[];
};
export type KnownComponent = LeafComponent | GroupComponent | InnerGroupComponent;
/** Blocks that can be newly added by AI modification operations and templates: only those recognized by this version, including within groups (D-254). */
export type NewComponent = z.infer<typeof ComponentSchema>;
/** Blocks on the page: recognized components, or those added by newer apps (D-254). */
export type Component = KnownComponent | UnknownComponent;
export type ComponentType = KnownComponent['look'];
export type ComponentOf<T extends ComponentType> = Extract<KnownComponent, { look: T }>;
/** v34 nomenclature: block, appearance. */
export type Block = Component;
export type KnownBlock = KnownComponent;
export type Look = ComponentType;
export type BlockOf<T extends Look> = ComponentOf<T>;

/** A definition in the registry, unifying callback parameters as blocks (extracted by appearance for use). */
export interface ComponentDefinition extends LookMeta {
  look: ComponentType;
  refs?: Readonly<Record<string, ComponentRef | undefined>>;
  check?(c: KnownComponent, ctx: CheckContext): CheckProblem[];
  describe(c: KnownComponent, config: WorkspaceConfig, ctx: DescribeContext): string;
  edit: ComponentEdit;
  ai: ComponentAI;
  example: Record<string, unknown>;
  shape: z.ZodRawShape;
  schema: z.ZodObject;
}

/** Card-type appearance that can use an image instead of a background color (edit.backdrop, D-258). */
export const BACKDROP_TYPES: readonly ComponentType[] = COMPONENTS.filter(
  (d) => (d.edit as ComponentEdit).backdrop,
).map((d) => d.look);

const BY_LOOK = new Map<string, ComponentDefinition>(
  COMPONENTS.map((d) => [d.look, d as unknown as ComponentDefinition]),
);

/** Definition of this appearance. */
export function componentDefinition(look: ComponentType): ComponentDefinition {
  return BY_LOOK.get(look)!;
}

/** Blocks recognized by this version (D-254). */
export function isKnownComponent(c: Component): c is KnownComponent {
  return BY_LOOK.has(c.look as unknown as string);
}

/** Values in a block that reference a certain kind of thing (e.g. table -> table ID). Unrecognized blocks have no references. */
export function componentRefs(c: Component, to: ComponentRef['to']): unknown[] {
  if (!isKnownComponent(c)) return [];
  const refs = componentDefinition(c.look).refs ?? {};
  return Object.entries(refs).flatMap(([path, ref]) => {
    const value = valueAt(c, path);
    return ref?.to === to && value !== undefined ? [value] : [];
  });
}
