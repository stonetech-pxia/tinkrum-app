// Field types supported by groupings (Grouping in v34, schema-primitives.ts). Constants only: block
// definitions reference them; grouping calculations reside in list-groups.ts and source.ts (which
// use data, so block definitions cannot reference them to avoid circular loading).

// Types supported by list section fields (for validation and prompt use); system fields createdAt / updatedAt are also allowed.

/** Types supported by list section fields (for validation and prompt use); system fields createdAt / updatedAt are also allowed. */
export const GROUP_BY_TYPES: readonly string[] = ['choice', 'link', 'date', 'datetime', 'schedule'];
