import { RECORD_REF, type Component } from './schema';

// Page for a single record (D-342): config writes "$record", which is replaced on the device with
// that record's ID when opening the page. Only replaces values in blocks that exactly equal
// "$record" (source filter value, preset value of inline tools, and when), leaving everything else
// unchanged; AI cannot see IDs (D-042).

function bind(value: unknown, recordId: string): unknown {
  if (value === RECORD_REF) return recordId;
  if (Array.isArray(value)) return value.map((v) => bind(v, recordId));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = bind(v, recordId);
    return out;
  }
  return value;
}

/** Replaces "$record" in blocks (along with sub-blocks in groups) with this record's ID (used during rendering; config itself remains unchanged). */
export function bindRecord<C extends Component>(component: C, recordId: string): C {
  return bind(component, recordId) as C;
}
