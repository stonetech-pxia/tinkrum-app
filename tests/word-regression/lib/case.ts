import type { Check } from './checks';

/** A regression test case: assertions that page pages/<suite>/NN-<id>.* must satisfy after converting to Word. */
export interface Case {
  /** Matches the case name in the source filename (e.g., pages/<suite>/NN-<id>.html). */
  id: string;
  /** Which PDF file it belongs to (pdfs/<suite>.pdf). */
  suite: string;
  /** Which fix it guards: commit hash, D number. */
  fix: string;
  /** One sentence describing what this page tests and what it previously failed as. */
  what: string;
  /** Recognition language (lang parameter for ocr.toWord), defaulting to eng. */
  lang?: string;
  /** App language, defaulting to en. */
  locale?: string;
  checks: Check[];
  /** Threshold for the general "all text present, no duplicates" check (defaults to 0.97 / 0.02). */
  recall?: number;
  extra?: number;
  /** Currently known failure (pending fix): describe the reason. Remove after fixing, and test execution will remind you. */
  knownFailure?: string;
}
