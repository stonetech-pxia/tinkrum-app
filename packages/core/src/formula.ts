// Formula fields (D-188): values calculated from other number fields in a data table, e.g.,
// `{price} * {qty}`. Only numbers, field references `{field ID}`, + - * /, parentheses, and minus
// sign: parsed into a small expression tree and evaluated without executing any code, variables, or
// loops. Values are not stored in records, computed on the fly for display and statistics. D-246:
// Add a restricted condition if(comparison, true_case, false_case). Comparison can only be written
// in the first argument of if, with only > < >= <= =; if counts as one nesting level, upper limit
// of nesting depth and length unchanged. D-247: Dates. Date field `{due}` and today are "dates",
// can only be placed in days(from, to) (difference in days, to − from) or if comparisons, cannot
// use arithmetic operators; formula result must always be a number. Types checked during validation
// based on field type (formulaType). D-280: Functions min, max, round, abs; time `{time}` and
// datetime `{datetime}` can only be placed in hours(from, to) / minutes(from, to) or if comparisons
// (time automatically adds 24 hours across midnight), datetimes can also be placed in days();
// durations treated as minutes. D-281: Formulas can reference other formula fields (circular
// references blocked during checking), max 500 characters.

export const MAX_FORMULA_LENGTH = 500;

export type Comparison = '>' | '<' | '>=' | '<=' | '=';

export type FormulaNode =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; field: string }
  | { kind: 'neg'; arg: FormulaNode }
  | { kind: 'op'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
  | { kind: 'today' }
  | { kind: 'days'; from: FormulaNode; to: FormulaNode }
  | { kind: 'fn'; fn: FormulaFunction; args: FormulaNode[] }
  | {
      kind: 'if';
      cmp: Comparison;
      left: FormulaNode;
      right: FormulaNode;
      then: FormulaNode;
      otherwise: FormulaNode;
    };

export type ParsedFormula =
  { ok: true; node: FormulaNode; refs: string[] } | { ok: false; error: string };

type Token =
  | { t: 'num'; value: number }
  | { t: 'ref'; field: string }
  | { t: 'cmp'; cmp: Comparison }
  | { t: 'if' | 'today' | 'days' }
  | { t: 'fn'; fn: FormulaFunction }
  | { t: '+' | '-' | '*' | '/' | '(' | ')' | ',' };

/** D-280 functions: parameter count [min, max]. */
const FUNCTIONS = {
  min: [2, 10],
  max: [2, 10],
  round: [1, 2],
  abs: [1, 1],
  hours: [2, 2],
  minutes: [2, 2],
} as const;
export type FormulaFunction = keyof typeof FUNCTIONS;
const isFunction = (word: string): word is FormulaFunction => Object.hasOwn(FUNCTIONS, word);

/** Recognized words in formulas: if (D-246), today and days (D-247), and FUNCTIONS (D-280). */
const WORDS = new Set(['if', 'today', 'days']);

function tokenize(text: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ' || c === '\t') {
      i++;
    } else if ('+-*/(),'.includes(c)) {
      tokens.push({ t: c as '+' });
      i++;
    } else if (c === '，') {
      tokens.push({ t: ',' });
      i++;
    } else if (c === '>' || c === '<') {
      const orEqual = text[i + 1] === '=';
      tokens.push({ t: 'cmp', cmp: `${c}${orEqual ? '=' : ''}` as Comparison });
      i += orEqual ? 2 : 1;
    } else if (c === '≥' || c === '≤') {
      tokens.push({ t: 'cmp', cmp: c === '≥' ? '>=' : '<=' });
      i++;
    } else if (c === '=') {
      tokens.push({ t: 'cmp', cmp: '=' });
      i++;
    } else if (/[a-zA-Z]/.test(c)) {
      const word = /^[a-zA-Z]+/.exec(text.slice(i))![0];
      const lower = word.toLowerCase();
      if (isFunction(lower)) tokens.push({ t: 'fn', fn: lower });
      else if (WORDS.has(lower)) tokens.push({ t: lower as 'if' | 'today' | 'days' });
      else return `unknown word "${word}"`;
      i += word.length;
    } else if (c === '×') {
      tokens.push({ t: '*' });
      i++;
    } else if (c === '÷') {
      tokens.push({ t: '/' });
      i++;
    } else if (c === '{') {
      const end = text.indexOf('}', i);
      if (end < 0) return 'unclosed {';
      const field = text.slice(i + 1, end).trim();
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(field)) return `bad field id "${field}"`;
      tokens.push({ t: 'ref', field });
      i = end + 1;
    } else if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+|^\d+\.?/.exec(text.slice(i))!;
      const value = Number(m[0]);
      if (!Number.isFinite(value)) return `bad number "${m[0]}"`;
      tokens.push({ t: 'num', value });
      i += m[0].length;
    } else {
      return `unexpected "${c}"`;
    }
  }
  return tokens;
}

/** Parse formula; referenced fields listed with deduplication in order of appearance. */
export function parseFormula(text: string): ParsedFormula {
  if (text.length > MAX_FORMULA_LENGTH) return { ok: false, error: 'too long' };
  const tokenized = tokenize(text);
  if (typeof tokenized === 'string') return { ok: false, error: tokenized };
  const tokens: Token[] = tokenized;
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];

  // Addition/subtraction → multiplication/division → minus sign → number / field / parentheses.
  function expr(): FormulaNode | string {
    let left = term();
    while (typeof left !== 'string' && (peek()?.t === '+' || peek()?.t === '-')) {
      const op = tokens[pos++]!.t as '+' | '-';
      const right = term();
      if (typeof right === 'string') return right;
      left = { kind: 'op', op, left, right };
    }
    return left;
  }
  function term(): FormulaNode | string {
    let left = unary();
    while (typeof left !== 'string' && (peek()?.t === '*' || peek()?.t === '/')) {
      const op = tokens[pos++]!.t as '*' | '/';
      const right = unary();
      if (typeof right === 'string') return right;
      left = { kind: 'op', op, left, right };
    }
    return left;
  }
  function unary(): FormulaNode | string {
    if (peek()?.t === '-') {
      pos++;
      const arg = unary();
      return typeof arg === 'string' ? arg : { kind: 'neg', arg };
    }
    return atom();
  }
  function atom(): FormulaNode | string {
    const token = tokens[pos++];
    if (!token) return 'unexpected end';
    if (token.t === 'num') return { kind: 'num', value: token.value };
    if (token.t === 'ref') return { kind: 'ref', field: token.field };
    if (token.t === '(') {
      if (++depth > 20) return 'too deeply nested';
      const inner = expr();
      if (typeof inner === 'string') return inner;
      if (tokens[pos++]?.t !== ')') return 'missing )';
      depth--;
      return inner;
    }
    if (token.t === 'if') return ifCall();
    if (token.t === 'today') return { kind: 'today' };
    if (token.t === 'days') return daysCall();
    if (token.t === 'fn') return fnCall(token.fn);
    return `unexpected "${tokenText(token)}"`;
  }
  // min / max / round / abs / hours / minutes: comma-separated arguments, count validated against FUNCTIONS.
  function fnCall(fn: FormulaFunction): FormulaNode | string {
    if (tokens[pos++]?.t !== '(') return `${fn} needs ( after it`;
    if (++depth > 20) return 'too deeply nested';
    const args: FormulaNode[] = [];
    for (;;) {
      const arg = expr();
      if (typeof arg === 'string') return arg;
      args.push(arg);
      const next = tokens[pos++];
      if (next?.t === ')') break;
      if (next?.t !== ',') return 'missing )';
    }
    depth--;
    const [least, most] = FUNCTIONS[fn];
    if (args.length < least || args.length > most)
      return least === most
        ? `${fn} needs ${least} part${least === 1 ? '' : 's'}`
        : `${fn} needs ${least} to ${most} parts`;
    return { kind: 'fn', fn, args };
  }
  // days(from, to): difference in days between two dates.
  function daysCall(): FormulaNode | string {
    if (tokens[pos++]?.t !== '(') return 'days needs ( after it';
    if (++depth > 20) return 'too deeply nested';
    const from = expr();
    if (typeof from === 'string') return from;
    if (tokens[pos++]?.t !== ',') return 'days needs two dates';
    const to = expr();
    if (typeof to === 'string') return to;
    if (tokens[pos++]?.t !== ')') return 'missing )';
    depth--;
    return { kind: 'days', from, to };
  }
  // if(comparison, true_case, false_case): comparison is "expression operator expression", can only appear here.
  function ifCall(): FormulaNode | string {
    if (tokens[pos++]?.t !== '(') return 'if needs ( after it';
    if (++depth > 20) return 'too deeply nested';
    const left = expr();
    if (typeof left === 'string') return left;
    const cmp = tokens[pos++];
    if (cmp?.t !== 'cmp') return 'if needs a comparison (> < >= <= =) first';
    const right = expr();
    if (typeof right === 'string') return right;
    if (tokens[pos++]?.t !== ',') return 'if needs a comma after the comparison';
    const then = expr();
    if (typeof then === 'string') return then;
    if (tokens[pos++]?.t !== ',') return 'if needs three parts';
    const otherwise = expr();
    if (typeof otherwise === 'string') return otherwise;
    if (tokens[pos++]?.t !== ')') return 'missing )';
    depth--;
    return { kind: 'if', cmp: cmp.cmp, left, right, then, otherwise };
  }

  const node = expr();
  if (typeof node === 'string') return { ok: false, error: node };
  if (pos < tokens.length) {
    return { ok: false, error: `unexpected "${tokenText(tokens[pos]!)}"` };
  }
  const refs: string[] = [];
  const collect = (n: FormulaNode) => {
    if (n.kind === 'ref' && !refs.includes(n.field)) refs.push(n.field);
    else if (n.kind === 'neg') collect(n.arg);
    else if (n.kind === 'op') {
      collect(n.left);
      collect(n.right);
    } else if (n.kind === 'if') {
      for (const part of [n.left, n.right, n.then, n.otherwise]) collect(part);
    } else if (n.kind === 'days') {
      collect(n.from);
      collect(n.to);
    } else if (n.kind === 'fn') {
      for (const arg of n.args) collect(arg);
    }
  };
  collect(node);
  if (refs.length === 0) return { ok: false, error: 'no fields' };
  return { ok: true, node, refs };
}

const tokenText = (token: Token) =>
  token.t === 'cmp' ? token.cmp : token.t === 'fn' ? token.fn : token.t;

/** Field types in formulas: number (number, amount, rating, duration, other formulas), date, time (HH:mm), datetime. */
export type FormulaType = 'number' | 'date' | 'time' | 'datetime';

/** Parameter types for days(), hours(), minutes(): only fields and today qualify as date/time types (all other expressions evaluate to numbers). */
function argType(n: FormulaNode, typeOf: (field: string) => FormulaType | null): FormulaType {
  if (n.kind === 'today') return 'date';
  return n.kind === 'ref' ? (typeOf(n.field) ?? 'number') : 'number';
}

/**
 * Formula type (D-247): dates can only go into days() and comparisons; arithmetic, unary minus,
 * and both results of if must be numbers. Times and datetimes (D-280) can only go into hours(),
 * minutes(), and comparisons; datetimes can also go into days(). typeOf provides field types
 * (unsupported fields return null); returns result type or an error description string.
 */
export function formulaType(
  node: FormulaNode,
  typeOf: (field: string) => FormulaType | null,
): FormulaType | { error: string } {
  const need = (n: FormulaNode, want: FormulaType, where: string): { error: string } | null => {
    const got = formulaType(n, typeOf);
    if (typeof got !== 'string') return got;
    return got === want ? null : { error: `${where} needs a ${want}, not a ${got}` };
  };
  switch (node.kind) {
    case 'num':
      return 'number';
    case 'today':
      return 'date';
    case 'ref':
      return typeOf(node.field) ?? { error: `${node.field} can't be used in a formula` };
    case 'neg':
      return need(node.arg, 'number', 'a minus sign') ?? 'number';
    case 'op':
      return need(node.left, 'number', node.op) ?? need(node.right, 'number', node.op) ?? 'number';
    case 'days': {
      for (const part of [node.from, node.to]) {
        const got = formulaType(part, typeOf);
        if (typeof got !== 'string') return got;
        if (got !== 'date' && got !== 'datetime')
          return { error: `days() needs a date or datetime, not a ${got}` };
      }
      return 'number';
    }
    case 'fn': {
      if (node.fn === 'hours' || node.fn === 'minutes') {
        const from = formulaType(node.args[0]!, typeOf);
        if (typeof from !== 'string') return from;
        if (from !== 'time' && from !== 'datetime')
          return { error: `${node.fn}() needs two times or two datetimes, not a ${from}` };
        return need(node.args[1]!, from, `${node.fn}()`) ?? 'number';
      }
      for (const arg of node.args) {
        const bad = need(arg, 'number', `${node.fn}()`);
        if (bad) return bad;
      }
      return 'number';
    }
    case 'if': {
      const left = formulaType(node.left, typeOf);
      if (typeof left !== 'string') return left;
      return (
        need(node.right, left, 'the comparison') ??
        need(node.then, 'number', 'if') ??
        need(node.otherwise, 'number', 'if') ??
        'number'
      );
    }
  }
}

/** Local date YYYY-MM-DD → day number (calculated in UTC, unaffected by daylight saving time); undefined when not a date. */
export function dayNumber(date: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 : undefined;
}

/** Time HH:mm → minutes of the day; undefined when not a time. */
export function minuteOfDay(time: string): number | undefined {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** Local datetime YYYY-MM-DDTHH:mm → minute number (calculated in UTC, unaffected by daylight saving time); undefined when not a datetime. */
export function minuteNumber(datetime: string): number | undefined {
  const day = dayNumber(datetime.slice(0, 10));
  const minute = datetime[10] === 'T' ? minuteOfDay(datetime.slice(11)) : undefined;
  return day === undefined || minute === undefined ? undefined : day * 1440 + minute;
}

/**
 * Evaluate; returns undefined if any field is unfilled, division by zero occurs, or result is not
 * a finite number (not displayed, excluded from stats). Date fields provide day number via
 * valueOf (dayNumber), time provides minutes of the day (minuteOfDay), datetime provides minute
 * number (minuteNumber), duration is minutes; today is today's day number, formulas referencing
 * today have no value if today is missing. typeOf provides field types (days() converts datetime
 * to days, hours() needs to know if time crosses midnight).
 */
export function evaluateFormula(
  node: FormulaNode,
  valueOf: (field: string) => number | undefined,
  today?: number,
  typeOf: (field: string) => FormulaType | null = () => 'number',
): number | undefined {
  const at = (n: FormulaNode) => evaluateFormula(n, valueOf, today, typeOf);
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'today':
      return today;
    case 'days': {
      // Calculate datetime based on its calendar date.
      const day = (n: FormulaNode) => {
        const v = at(n);
        return v !== undefined && argType(n, typeOf) === 'datetime' ? Math.floor(v / 1440) : v;
      };
      const from = day(node.from);
      const to = day(node.to);
      return from === undefined || to === undefined ? undefined : to - from;
    }
    case 'fn': {
      const args = node.args.map(at);
      if (args.some((v) => v === undefined)) return undefined;
      const [a, b] = args as number[];
      switch (node.fn) {
        case 'min':
          return Math.min(...(args as number[]));
        case 'max':
          return Math.max(...(args as number[]));
        case 'abs':
          return Math.abs(a!);
        case 'round': {
          // Decimal places clamped to integer, limited to 0–4 (same as field decimals), rounded (negative numbers also round away from 0).
          const f = 10 ** Math.min(4, Math.max(0, Math.round(b ?? 0)));
          return (Math.sign(a!) * Math.round(Math.abs(a!) * f + 1e-9)) / f;
        }
        case 'hours':
        case 'minutes': {
          let diff = b! - a!;
          // Time has only hours and minutes: end earlier than start means it crossed midnight.
          if (diff < 0 && argType(node.args[0]!, typeOf) === 'time') diff += 1440;
          return node.fn === 'hours' ? diff / 60 : diff;
        }
      }
    }
    case 'ref':
      return valueOf(node.field);
    case 'neg': {
      const v = at(node.arg);
      return v === undefined ? undefined : -v;
    }
    case 'op': {
      const a = at(node.left);
      const b = at(node.right);
      if (a === undefined || b === undefined) return undefined;
      const r =
        node.op === '+'
          ? a + b
          : node.op === '-'
            ? a - b
            : node.op === '*'
              ? a * b
              : b === 0
                ? NaN
                : a / b;
      return Number.isFinite(r) ? r : undefined;
    }
    case 'if': {
      // If either side of a comparison lacks a value, the entire formula has no value (does not guess which side).
      const a = at(node.left);
      const b = at(node.right);
      if (a === undefined || b === undefined) return undefined;
      return at(compare(a, node.cmp, b) ? node.then : node.otherwise);
    }
  }
}

/** Equality allows for tiny precision error (0.1 + 0.2 = 0.3). */
function compare(a: number, cmp: Comparison, b: number): boolean {
  const same = Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  switch (cmp) {
    case '=':
      return same;
    case '>':
      return a > b && !same;
    case '<':
      return a < b && !same;
    case '>=':
      return a > b || same;
    case '<=':
      return a < b || same;
  }
}
