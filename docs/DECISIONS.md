# Decision log

The decisions are in [`docs/decisions/`](decisions/), one file per hundred numbers and one heading per decision (`### D-617 — title`).

- [D-001-099.md](decisions/D-001-099.md): D-007 to D-095, 82 decisions
- [D-100-199.md](decisions/D-100-199.md): D-104 to D-199, 80 decisions
- [D-200-299.md](decisions/D-200-299.md): D-200 to D-299, 96 decisions
- [D-300-399.md](decisions/D-300-399.md): D-300 to D-399, 94 decisions
- [D-400-499.md](decisions/D-400-499.md): D-400 to D-499, 98 decisions
- [D-500-599.md](decisions/D-500-599.md): D-500 to D-599, 90 decisions
- [D-600-699.md](decisions/D-600-699.md): D-600 to D-619, 19 decisions
- [P.md](decisions/P.md): 50 questions awaiting the founder (P items), each with the default applied meanwhile

An entry says what was decided, why, and who decided it when. It is not the specification: the exact rules, limits and steps are in the code, its tests and the generated guide in `docs/agent/`. Where an entry and the code disagree about a detail, read the code; where they disagree about what was decided, the entry wins and the code has a bug.

## Finding a decision

- By number: `git grep -n "^### D-617 " docs/decisions`.
- By subject: `git grep -n "^### " docs/decisions | grep -i <word>` lists the titles; then open the entry.
- A later decision overrides an earlier one. An entry that a later decision changed ends with a line "Changed later by: D-…"; read those too.
- Decisions made before D-368 use the config names from before v34; `docs/ARCHITECTURE.md` §11 maps them to today's names.
- A number with no entry was either never used (given up when branches were renumbered) or deleted on 2026-11-22; see below.

## Adding a decision

Append it to the file for its hundred (start a new file at a new hundred) in this shape:

```md
### D-620 — What was decided, in a few words

Two or three sentences: what was decided and its main boundary. When the founder decided or confirmed it, say where and on what day.

**Why:** the reason, in one sentence.

**Status:** Decided | Provisional | Awaiting the founder; add "not verified on a device" while that is true.
```

Write the decision, not the specification and not the story of building it: the rules go in the code and its tests, which files changed goes in the commit. When a decision changes an earlier one, say so and add or extend the "Changed later by" line at the end of the earlier entry. When a decision is replaced as a whole, delete its text and leave one line saying what replaced it. A fix or a progress note is not a decision and gets no entry.

## What happened on 2026-11-22

Until then the log was one table in this file (1.4 MB) whose entries carried the full specification of each decision. It was split into `docs/decisions/` and cut to summaries (see D-new-vibe-checkup-1 in the last file). Every entry as it was written: `git show 96a978d4:docs/DECISIONS.md`.

Deleted, 28 entries that nothing cites: D-001–D-006, D-013, D-015–D-016, D-022, D-027, D-030, D-069, D-107, D-201, D-229, D-320, D-339, D-345, D-350, D-353, D-356, D-494–D-495, D-504–D-505, D-514, D-608.

Text deleted because the decision was superseded or cancelled as a whole: D-014, D-202, D-206, D-365, D-379.
