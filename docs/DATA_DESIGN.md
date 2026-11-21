# User data design (data components: list, form, stat)

> Status: **implemented** (2026-10-22, schemaVersion 3). Section 9 was confirmed by the founder, see DECISIONS D-036–D-043.
> Related: for restore semantics see "Product background" §7E in AGENTS.md, for user files §7G, for the cloud [CLOUD_DESIGN.md](CLOUD_DESIGN.md).

## 1. Goals

- With one sentence the user builds a page that **can record things**: bookkeeping, to-dos, a reading list, notes, a customer list, ...
- **The data belongs to the user**: changing the UI, undoing, restoring a historical version, or uninstalling a tool never deletes or alters what the user entered (the same principle as user files, the §6 invariant).
- **The AI designs only the "shape" of the data and how it is displayed**; it neither reads nor writes what the user entered (§8: send as little as possible to the model).
- It stays whitelist + declarative: no formulas, scripts or arbitrary queries, and it stays non-Turing-complete (§7C, the app store's dynamic-code policy).

## 2. The core split: structure is in the config, content is outside it

|                                | Table structure (Collection)                                       | Records (Record)                                                             |
| ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Example                        | The "Expenses" table has four fields: amount, category, date, note | "Lunch 35 yuan Food 10-22"                                                   |
| Where it lives                 | `WorkspaceConfig.collections`, saved with versions                 | SQLite `records` table, not with versions                                    |
| Who changes it                 | The AI or the change flow: preview → confirm → undoable            | The user adds, deletes and edits directly on the page, effective immediately |
| Restoring a historical version | Restored                                                           | **Not restored, not deleted**                                                |
| Sent to the AI                 | Sent (table names, field names, option text)                       | **Never sent**                                                               |

This matches the existing split of "tool config goes with versions, user files are independent". When the user undoes a UI change, the entry just recorded is not lost.

## 3. Table structure

```jsonc
// WorkspaceConfig adds collections (schemaVersion 3)
"collections": [
  {
    "id": "expenses",
    "name": "Expenses",
    "icon": "chart",
    "fields": [
      { "id": "amount",   "name": "Amount", "type": "money", "currency": "CNY", "required": true },
      { "id": "category", "name": "Category", "type": "choice",
        "options": [{ "id": "food", "label": "Food" }, { "id": "transport", "label": "Transport" }] },
      { "id": "date",     "name": "Date", "type": "date", "default": "today" },
      { "id": "note",     "name": "Note", "type": "text" }
    ]
  }
]
```

### Field types (whitelist)

| Type       | Stored value                                                                        | Typical use               |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------- |
| `text`     | String, ≤ 200 characters                                                            | Title, name               |
| `note`     | String, ≤ 5000 characters                                                           | Note body                 |
| `number`   | Number; can set decimal places (0–4) and a unit (such as "pages", "km")             | Quantity, progress        |
| `money`    | Number (2 decimal places) + currency (ISO code, one per field)                      | Amount                    |
| `checkbox` | true / false                                                                        | Done, read                |
| `date`     | `YYYY-MM-DD`, device-local date                                                     | Date, due date            |
| `choice`   | Option ID; a list if `multiple` (D-607); options can have `value`, `color` (D-568)  | Category, weekdays        |
| `rating`   | Integer 1–5                                                                         | Rating                    |
| `tags`     | A set of text (stored in the record, the config has no tag names, D-432)            | Tags                      |
| `file`     | A set of Morph file IDs, up to 20 (D-187, D-263)                                    | Receipts, photos          |
| `formula`  | No stored value, computed from `expression` (D-188, D-246)                          | Subtotal, with tax        |
| `link`     | ID of a record in another table (D-250)                                             | Customer of an order      |
| `time`     | `HH:mm`, hour and minute (D-279)                                                    | Work start time           |
| `datetime` | `YYYY-MM-DDTHH:mm`, device-local (D-279)                                            | Clock-in, feeding         |
| `duration` | Integer minutes, shown as `h:mm` (D-279)                                            | Break, duration           |
| `lookup`   | No stored value, a field of the record it refers to (D-287)                         | Hourly rate of a work log |
| `rollup`   | No stored value, a statistic over the records that refer to this one (D-288)        | Customer total            |
| `previous` | No stored value, the value of the previous record in the same group by date (D-289) | Last mileage              |
| `schedule` | A repeat rule (whitelisted JSON, D-292)                                             | Watering, renewal         |

Every record also carries two system fields, `createdAt` and `updatedAt`, which can be used for sorting and filtering.

### Rules

- **IDs are stable, names can change**: fields and options have fixed IDs; renaming changes only the displayed text and existing data is unaffected.
- **Deleting a field = hiding it**: the field's values in records stay untouched; when you restore an old version the field reappears and so does the data.
- **Deleting an option**: records that had selected it show empty (the data is still there and comes back after a restore).
- **Changing a field's type**: only compatible conversions are allowed (`text ↔ note`, `number ↔ money`). Otherwise create a new field (proposed, see Q3 in section 9).
- **Defaults**: `date` can be `"today"`; other types use a constant.
- **Limits**: 20 tables per workspace, 30 fields per table, 50 options per choice field.

## 4. Records

```sql
-- Added to the local database (PRAGMA user_version 3)
CREATE TABLE records (
  id            TEXT PRIMARY KEY,      -- UUID
  collection_id TEXT NOT NULL,
  values_json   TEXT NOT NULL,         -- { field ID: value }
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER                -- soft delete
);
CREATE INDEX records_by_collection ON records (collection_id, deleted_at, created_at);
```

- **Strict on write**: validate against the current field definitions (`core` provides the pure function `validateRecord`); invalid values cannot be saved.
- **Tolerant on read**: values that do not match the current definition (for example the type changed after restoring an old version) are simply not shown, and **must never crash the page**. Records do not go through version validation, so the renderer must withstand any data.
- **Values of deleted fields** stay as they are in `values_json` and are not shown.
- **Deleting a record**: soft delete; the banner offers "Undo"; "Settings → Data → Recently deleted" keeps it for 30 days (see Q2).
- **A table removed from the config** (the AI deleted the table, or restored to a version before the table was created): the records are kept. "Settings → Data" lists "unused tables", which can be exported or permanently deleted (with confirmation). When the same table ID reappears, the data comes back automatically.
- **Scale**: soft cap of 10,000 records per table (when full, no more can be added). In the implementation, filtering, sorting and statistics are computed in memory with the pure functions in `core` (the same logic as the tests); when there are very many records, switch to SQLite `json_extract` (D-043).

## 5. Data components

| Component    | Main properties                                                                                                                          | Notes                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `recordList` | `collectionId`, `display` (`list` / `cards` / `checklist`), `titleField`, `subtitleFields` (≤ 2), `filter`, `sort`, `limit`, `emptyText` | Tap one to open it for editing; `checklist` ticks directly with a `checkbox` field                 |
| `recordForm` | `collectionId`, `fieldIds`, `submitLabel`, `mode` (`inline` / `button`)                                                                  | Quick add: `inline` fills in directly on the page, `button` opens the full form                    |
| `stat`       | `collectionId`, `aggregate` (`count` / `sum` / `avg` / `min` / `max`), `fieldId`, `filter`, `label`, `groupBy` (D-248)                   | For example "This month's spending ¥1,234", "5 items not done"; `groupBy` gives one row per option |

**Filters** can use only whitelisted conditions; several conditions are combined with "and", and there are no expressions:

```jsonc
"filter": [
  { "field": "date", "op": "inPeriod", "value": "thisMonth" },
  { "field": "category", "op": "is", "value": "food" }
],
"sort": { "field": "date", "direction": "desc" }
```

Available conditions: `is` / `isNot` / `contains` / `gt` / `lt` / `isEmpty` / `isNotEmpty` / `inPeriod`, and schedule fields also have `due` (`today` / `overdue` / `thisWeek`, D-294). The values of `inPeriod` are `today`, `thisWeek`, `thisMonth`, `thisYear`, `last7days`, `last30days`; D-285 added `last14days`, `last90days`, `last365days`, `thisTwoWeeks` (a two-week span) and `thisHalfMonth` (the 1st–15th, or the 16th to the end of the month). D-537 added `next7days`, `next30days`, `next90days` (today and the following days), and `gt` / `lt` on a date accept `"today"`. D-559 added the whole calendar periods next to the current one: `yesterday`, `lastWeek`, `lastMonth`, `lastYear`, `tomorrow`, `nextWeek`, `nextMonth`. D-538: `is` on a choice field may take a list of 2–8 option ids (any of them); there is no OR across fields. "Today" and the first day of the week follow "Settings → Days and weeks" (D-286).

The **record edit page** is generated by the core from the field definitions: tapping one in a list, or the `button` mode of `recordForm`, opens it, and deleting is also done here. Since D-570 the layout of its form is config, in four ways only (§24): sections and conditional display (`form` on the table), a hint under a field and a range for numbers (on the field); saving, deleting, attachments, suggested values and the rest of the page stay the kernel's, and the page does not become a free page. The row of buttons at the top of the page for an existing record is configured by `recordRow` on the table (D-428, replacing the hard-coded row of D-423): each button is a quick action, and tapping it hands the value of this field or this record to it; with no configuration there is no row.

These three components, like the other components, can be put inside groups, for example two `stat` side by side, or a list below a grid.

## 6. AI operations

New operations:

| Operation                                                                          | Notes                                                     |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `addCollection {collection}`                                                       | Create a table                                            |
| `updateCollection {collectionId, name?, icon?}`                                    | Rename, change icon                                       |
| `addField {collectionId, field, index?}`                                           | Add a field                                               |
| `updateField {collectionId, fieldId, name?, options?, required?, default?, type?}` | Change a field; `type` allows only compatible conversions |
| `moveField {collectionId, fieldId, toIndex}`                                       | Reorder fields                                            |
| `removeField {collectionId, fieldId}`                                              | Hide the field, data is kept                              |
| `removeCollection {collectionId}`                                                  | Remove from the config, data is kept (see section 4)      |

Data components still use the existing operations such as `addComponent` / `setComponentProps`.

New **validator** checks: the table and fields a component refers to must exist; usage must match types (`sum` only for `number` / `money`, `checklist` needs a `checkbox` field, `inPeriod` only for `date` or system time fields); filter values must fit the field type and options.

**Change description** examples: "Create table 'Expenses' (amount, category, date, note)", "Hide field 'Note' of 'Expenses' (existing data is kept)".

**Quick actions writing records (D-187; since D-397 the files of this run go into the same record by default, the form and the record page are the same, and attachments are read automatically to give suggestions)**: `out.addRecord` shows a form generated from the table structure when the quick action runs, and the data is written to the database only after the user fills it in; files are stored as Morph files and put into the attachment field, placed first, with photos and files the user adds in the form after them (D-263). The AI decides only which table to record into.

**Attachments (D-263)**: the record edit page, the quick-add form and the "Add entry" form can all take a photo or pick from the photo library or "Files", and a copy is stored as a Morph user file; the original is untouched. Lists and cards show the thumbnail of the first image. In "Settings → Storage" the user sees where files are used and deletes them (D-264).

**The AI does not touch record contents**: requests such as "delete last month's expenses" or "mark all to-dos as done" are refused with a hint to do it directly on the page (the same category as `deleteFiles`). For whether the AI may write records on the user's behalf, see Q1.

### Example: "Make a bookkeeping page that shows how much I spent this month"

The model will output: `addCollection` (the Expenses table, same as section 3) + `addPage` + `setNavItems`. The new page looks like this:

```jsonc
{
  "id": "budget",
  "title": "Bookkeeping",
  "icon": "chart",
  "components": [
    { "id": "title", "type": "header", "props": { "title": "Bookkeeping" } },
    {
      "id": "month-total",
      "type": "stat",
      "props": {
        "collectionId": "expenses",
        "aggregate": "sum",
        "fieldId": "amount",
        "label": "Spent this month",
        "filter": [{ "field": "date", "op": "inPeriod", "value": "thisMonth" }],
      },
    },
    {
      "id": "add",
      "type": "recordForm",
      "props": {
        "collectionId": "expenses",
        "fieldIds": ["amount", "category", "note"],
        "submitLabel": "Add entry",
        "mode": "inline",
      },
    },
    {
      "id": "recent",
      "type": "recordList",
      "props": {
        "collectionId": "expenses",
        "display": "list",
        "titleField": "note",
        "subtitleFields": ["category", "date"],
        "sort": { "field": "date", "direction": "desc" },
        "limit": 20,
        "emptyText": "No entries yet",
      },
    },
  ],
}
```

The **mock AI** gains several built-in templates, such as "create a bookkeeping page", "create a to-do list", "create a reading list", "create notes", and single changes such as "add a 'payment method' field to expenses".

## 7. Restore, migration, sync, export

- **§7E restore semantics** gain two rows: table structure → restored; records → not restored, not deleted.
- **Migration**: config schemaVersion 2 → 3, adding `collections: []`; the local database gains the `records` table.
- **New components and version numbers** (D-254): adding only a new kind of page component does not raise schemaVersion. When reading a stored config, components this version does not recognize are kept as they are (the original JSON is written back on save), and the page shows a "needs a newer app" placeholder that can only be moved and deleted; the AI cannot add or change them. Changing an existing structure (adding a property to an existing component, adding a field type, changing the range of values) still requires raising the version number and writing a migration. Apps installed before this version still reject configs that contain the new component.
- **Cloud** (addition to CLOUD_DESIGN.md): a new `records` table (with `workspace_id`, protected by RLS). Versions are immutable and records are mutable, so the sync differs: each record is "last writer wins" by `updated_at`, and deletes use tombstone records. When two devices change the same record at the same time, the later change wins (field-level merge comes later).
- **Export**: each table can be exported as CSV and sent out through the system share sheet ("data over UI", §12).
- **Import** (D-574): Settings → Data → a table → "Import entries from a file" brings the rows of an .xlsx or .csv file into that existing table, on the device only. Columns are matched to fields by equal names (case, full-width and spaces ignored) and the user confirms or changes every column, with samples read the way they will be written; each cell is read leniently for a spreadsheet and then goes through the field's own `write`. Rows that cannot be written are left out and listed by reason in a summary the user confirms; at most 2,000 rows per import and never past the table's 10,000. All entries of an import are written in one transaction and kept as a batch in the database (`record_imports`, `import_items`), not in the config. The undo banner and "Delete this import" move the batch's entries still present to Recently deleted for 30 days (invariant 11). The logic is in `packages/core/src/records-import.ts`, the xlsx reading in `packages/tool-office/src/xlsx-import.ts` (`readXlsxRows`).

## 8. Not in this version

| Not done                                    | Reason / how it will be done later                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Relations between tables (customer ↔ order) | D-250 did one-way references and D-342 lists those that belong to one record on a page; multi-select and cascading delete are not done |
| Formulas, computed fields                   | D-188 / D-246 / D-247 did restricted formulas                                                                                          |
| Charts, calendar view                       | D-249 did charts; D-305 did the month calendar look                                                                                    |
| Repeating tasks, daily check-ins            | Need a rule for "generate records by date", designed separately                                                                        |
| Attachment field (referencing user files)   | Done in D-187 / D-263; searching by file content and multi-select filtering are not done                                               |
| The AI writing records                      | See Q1                                                                                                                                 |
| Sharing among several people                | Depends on accounts and the cloud                                                                                                      |
| Import of link fields, other encodings      | D-574 imports typed-in fields from UTF-8 / UTF-16; matching a link by its title and GBK / Latin-1 CSV are not done                     |

## 9. The founder's decisions (2026-10-22)

| #   | Item                                                                                                                      | Proposal                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Can the AI write records on the user's behalf (for example "log lunch 35")                                                | **Decided: no. The AI only changes the UI.** Such requests are refused with `userData` (D-036)                                                                   |
| Q2  | How long can a deleted record be recovered                                                                                | The banner can undo it, and in addition "Recently deleted" keeps it for 30 days, after which it is cleared automatically                                         |
| Q3  | Changing a field's type                                                                                                   | Only compatible conversions are allowed; otherwise create a new field and hide the old one (no data lost)                                                        |
| Q4  | Can the AI delete a table                                                                                                 | Yes, but it only removes it from the config and the data stays in "Settings → Data"; permanent deletion can only be done by the user manually, with confirmation |
| Q5  | Which templates the mock AI has in the first version                                                                      | Bookkeeping, to-dos, reading list, notes                                                                                                                         |
| Q6  | Whether the first version includes CSV export                                                                             | Yes: little work, and very important for trust in "the data belongs to the user"                                                                                 |
| Q7  | Table names, field names and option text are sent to the AI (users may write private things such as customer names there) | Accepted, treated the same as page titles; stated clearly in the privacy notice. Record contents are never sent                                                  |

## 10. How "the AI cannot read user data" is guaranteed

The founder required: it must be guaranteed that the AI cannot read user data. The implementation has three layers:

1. **Structural isolation**: records exist only in the database `records` table and are never written into `WorkspaceConfig`; the user message sent to the model consists only of `WorkspaceConfig` and the user's sentence (`buildUserMessage`).
2. **Interface isolation**: the `ctx` of `AIProvider.plan(input, ctx)` has only the config, the tool catalog and the language, with no access to the database or files; the planner (shared by the server-side and in-app transports) therefore cannot possibly read records.
3. **Tests**: `apps/mobile/src/__tests__/data-journeys-test.tsx` records an entry with special markers in the UI (including a person's name and an amount), then starts an AI change, and checks the **complete request** sent to Claude and all the parameters the AIProvider received: the table structure is in them, the markers, the name and the amount are not.

In addition, the AI cannot write records either: no operation reads or writes records; requests involving record contents are refused (`userData`).

## 11. Implementation plan (done)

1. **core**: schema v3 (collections, field types, three data components), new operations, validation, `validateRecord`, pure functions for filtering and statistics, change descriptions, migration, mock templates, prompt, eval cases.
2. **App**: `records` storage (SQLite + in-memory implementation), three data components, the record edit page, "Settings → Data" (unused tables, recently deleted, export CSV).
3. **Tests**: UI journey (build a bookkeeping page with the AI → record a few entries → statistics update → after undoing the UI change the records are still there → restore to a version before the table was created and restore back, data intact); evals use only Haiku.

The estimated effort is comparable to the previous milestone (styles and pages).

## 12. Formula conditions and dates (since D-246)

Formula fields (D-188) are still just a fixed syntax that is parsed into a small tree and then evaluated:

- **Conditions** (D-246): `if(left operator right, when true, when false)`, with operators `> < >= <= =`, allowed only as the first argument of `if`; they can be nested, and the limits on nesting depth (20) and length (200 characters at the time, 500 since D-281) are unchanged. If either side of a comparison has no value, the whole formula has no value. Example: `if({total} >= 100, {total} * 0.9, {total})`.
- **Dates** (D-247): the date field `{due}` and `today` are dates, `days(from, to)` is the number of days between them (to − from), and two dates can be compared inside `if`; dates cannot be added, subtracted, multiplied or divided, and the result must be a number. Examples: "days until due" = `days(today, {due})`, "late fee" = `if({paid} > {due}, days({due}, {paid}) * 5, 0)`. When a date field is empty there is no value; a formula that uses `today` changes its value every day.
- **Functions and time** (D-280): `min`, `max`, `round(x, digits?)`, `abs` work only on numbers; `hours(from, to)` / `minutes(from, to)` compute how long it is between two times or two datetimes, adding 24 hours when two time fields cross midnight (to < from); `days()` also accepts datetimes; a duration field is a number of minutes. Example: "hours worked" = `hours({start}, {end}) - {break} / 60`.
- **Referencing formulas** (D-281): a formula can reference other formulas of the same table (using the rounded value) and cannot loop back to itself; an expression is at most 500 characters (provisional, P-044).
- **Checkboxes and choices** (D-569): see §24.

## 13. Grouped statistics, charts, references between tables (since D-248)

- **Grouped statistics** (D-248, schemaVersion 13): `stat.groupBy` is a choice field, one row per option (in option order, including those with no records), and records with no choice go last under "Not set".
- **Charts** (D-249, schemaVersion 14): `chart {collectionId, kind: bar / line / pie, aggregate: count / sum / avg, fieldId?, group: day / week / month / choice, dateField?, choiceField?, periods?, filter?, title}`. Grouping by time shows the most recent few periods (default 7 days, 8 weeks, 6 months); grouping by a choice field gives one point per option; a pie chart can only be grouped by choice, and more than 7 slices are merged into "Other". Grouping and geometry are in `core/chart.ts`; the app draws bars with View and lines and pies with Skia `Path`.
- **References between tables** (D-250, schemaVersion 15): field `link {collectionId}`, whose value is the ID of that record and which displays its title field (the first text field). When the referenced record is deleted the value is kept and "Deleted entry" is shown, and it shows again after a restore; a table that another table still references cannot be removed (remove the reference field first). The only filter is "whether one is chosen" (on a page made for one record it can equal that record, D-342), and it cannot be used for sorting. Multi-select and cascading delete are not done.
- **Due reminders** (D-251, schemaVersion 16): a reminder in `reminders` with `schedule: dateField` follows a table's date field and reminds with a local notification at the `time` `daysBefore` days before it is due; the record is read on the device, the body text is generated on the device and contains only the table name (it appears on the lock screen, so no record title is written, P-043 ②), and the config holds only the settings. Tapping a reminder only opens a page or a quick action and does not run it.

## 14. Sample apps (since D-260)

- **Sample apps** (D-260): `packages/core/src/samples/<id>.json` brings several tables, pages, quick actions, home entries and reminders at once, with only the table structure and **no records at all**. When applied, IDs are replaced with non-conflicting ones for the current config (an existing table with the same name gets -2), and the user's existing tables and records are untouched; reference fields between tables, formulas, reminders, buttons and quick-action cards all point to the replaced IDs. If the tables or pages do not fit (20 of each), the whole set is not applied.
- **Onboarding guide step 3** (D-261, D-262): the whole change goes into a draft first, "Apply" makes it one version, and undo goes back to before it was applied; records are not in versions, so records entered after applying stay on the device after the undo ("undoing does not lose the entry just recorded", see section 4 and the principle at the start).

## 15. Ordered aggregates, periods, when a day and a week start (since D-284)

- **Ordered aggregates** (D-284, schemaVersion 20): `stat.aggregate` gains `streak` (current streak and best streak, `unit` day / week / month, `perUnit` the minimum number of records per unit, `skipField` + `skipOption` designating a choice option as "skip"), `daysSince`, `avgInterval`, `distinctDays`, computing days by `dateField` (default the first date field, or the creation time if there is none), and can be combined with `groupBy` for one row per option. Charts can only use `distinctDays`. The pure logic is in `core/sequence.ts`, with the interface "a set of records + a date field + parameters → a value", which summary fields will use later too.
- **Periods** (D-285): see `inPeriod` in the filter conditions above; shared by filters, `in.records`, `file.filter`, and the filters of statistics and charts.
- **When a day and a week start** (D-286): the config's `calendar {dayStartHour? 0–6, weekStart? monday / sunday, twoWeekStart?}`. All calculations that sort by day or week (periods, chart grouping, streak days, the default today of a date field, which day a creation time belongs to) follow it; the logic is in `core/calendar.ts`.

## 16. Lookup, rollup, previous (since D-287)

- **How values are stored**: they are not. The definitions of the three field kinds are in the config (structure), and the values are computed on the phone when records are read, by `core/related.ts` (`computeRecords`), and put into a copy of the record for lists, statistics, charts, the record page, CSV and reports; they are removed when a record is written. The AI can only add and change the definitions of these three field kinds (`addField`, `updateField`) and can neither see nor compute any values (D-042, D-113).
- **Lookup** (D-287) `lookup {linkField, fieldId}`: the `fieldId` of the record the reference field points to, displayed, filtered, sorted, and used in formulas and statistics according to that field's type (`expandCollection`).
- **Rollup** (D-288) `rollup {collectionId, linkField, aggregate, …}`: among the records of `collectionId` whose `linkField` points to this one, the count, sum, average, minimum, maximum, the value of the latest one, or the day-based aggregates of D-284; can take `filter` and `period`.
- **Previous** (D-289) `previous {fieldId, dateField?, groupBy?}`: the value of the nearest earlier record by date in the same table and the same group that has a value in `fieldId`.
- **Checks** (D-290): cannot loop back to itself, at most 3 levels stacked (P-045). **Performance** (D-291): one index per reference field per table, without scanning the table record by record.

## 17. Schedules (since D-292)

- **Schedule field** (D-292, schemaVersion 24): each record stores a repeat rule `{repeat, …, perDay?}` (every day, certain days of the week, N times per period, certain days of the month, every N days, a certain day each year), which the user sets in the form; the field's `default` is the rule for new records. The logic is in `core/schedule.ts`.
- **Last done** (D-293): `lastDone` points to a date or datetime field in the same table; from the rule and that field it computes the next time, whether it should be done today, and how many days overdue.
- **Used elsewhere** (D-294, D-295): the `due` filter; `inPeriod` / `gt` / `lt`, sorting and formulas all use the next time. For reminders sorted by record see D-316.
- **Once** (D-340, schemaVersion 30): `{repeat: once, date?}` is done once and ends when done; the filter `due: pending` means not yet done. **Doing it early counts as this time** (D-341): the field's `countEarly`.

## 18. One-tap record actions (since D-300)

- **Where they attach** (D-300, D-302, schemaVersion 25): the button's `action` (`create`, `setAll`, `open`, mutually exclusive with `target`), and the `rowActions` of each row of a record list (`set`, `toggle`, `increment`, `create`, `open`; each row shows the first one whose `when` is satisfied). The logic is in `core/record-ops.ts`.
- **Values that can be written** (D-301): a choice option, a number, a tick, `today`, `now`, clear; in the `create` of a row button the reference field can be `row`; text cannot be written.
- **Values from today or from this entry** (D-565): a date field may take `{from, add, unit}`, the same form and the same arithmetic as a computed date (D-542): `from` is `"today"` or a date / datetime field of this entry, `add` a whole number or a number field of this entry, `unit` days or months (a month end clamps). Any writable field except files and schedules may take `{copy: <field>}`: the value of that field of this entry at the moment of the tap (same type, or one `convertGroup`: number / money, text / note; a link to the same table; a choice whose options the target has; computed fields may be the source, never the target). `increment.by` may name a number field of this entry. "This entry" is the entry the tool acts on (`$row`: a row, tile or card tool, a reminder's `done`), otherwise the entry of a page for one entry (`$record`, a button there); `setAll`, forms and buttons elsewhere have none, so only `{from: "today", add: <number>}` works there. The config holds only field ids, never content (invariant 14), and the AI never sees values (invariant 2). Deleting a field such a value reads removes the tool (invariant 18). A home-screen widget does not run these tools itself; tapping opens the app.
- **Execution** (D-303, D-385): records are written on the device only after the user taps, without going through the AI and without creating a version. A single change shows no undo banner (the user unticks or edits it back); `setAll` asks first, handles at most 200 records at a time and shows no undo afterwards. When a field or table is deleted, the operations that use it are removed along with it (D-304).
- **One tap, several changes** (D-566): a row or tile tool may carry `also` (1–2 more writes: set, toggle or increment on this entry, or one create linked back with `$row`; at most 3 writes, a field once, no ask, no setAll, no nesting). All writes are saved in one transaction or none; the banner then offers Undo, which writes the entry's old values back and removes the created entry, only if nothing changed since. Not on page buttons, forms, checks, drags or a reminder's `done`; a widget opens the app for it.
- **Remove from a grid** (D-610): `{do: "remove", table}` only as `{as: "tap"}` on a check-in grid: a tap on a cell with exactly one entry moves it to Recently deleted (soft delete, as when the user deletes it) and the banner offers Undo. Refused anywhere else (row buttons, button blocks, a reminder's done, widgets).
- **Bulk create** (D-567): a button's `{do: "createAll", table, from, filter?, values}` creates one entry in `table` for every entry of `from` that matches `filter`; in `values`, `$row` is that source entry and `{copy}` / `{from, add, unit}` read its fields. The engine goes through the entries itself (no loop in the config). It asks first with the count, refuses over 200, creates all in one transaction, and the banner's Undo removes exactly that batch if none was changed since. Not on rows, tiles or a reminder's `done`; a widget opens the app for it. Record tools now have six kinds.
- **Pick several, create one each** (D-616): `pick: true` on `createAll` makes the source the entries the user checks, not every entry `filter` selects (`filter` only limits what can be checked). It only works as the `addHere` of a list, cards, checklist, table, gallery, board or calendar on the table it adds to: the Add opens a picker of `from`, and each new entry gets `"$row"` (exactly one link field to `from`) plus what `"$here"` gives (the equals of the list's filter, with `$record` on a page for one entry, and the section, column or day). Entries already linked in that section show as added and are not created again. The picker's button, which states the count and the table, is the question (no second dialog); cap of 200, transaction and batch Undo as D-567. This is how a join table that carries data (recipe → ingredients with an amount) is filled.

## 19. Month calendar, timing and progress, goals and comparisons in statistics (since D-305)

- **Month calendar** (D-305, schemaVersion 26): `recordList.display: "calendar"`, `dateField?`, `colorField?` (choice). A grid for one month, shaded by the number of records or colored by the option of the last record of the day; tapping a day lists that day's records below. The app reads only this month's records (`listRecordsInRange`; when the table has lookup, rollup or previous it reads the whole table).
- **Display format of the right-hand field** (D-306): `recordList.trailingFormat`: `elapsed` (start to end or to now, ticking every second when there is no end), `progress` (value / goal, where the goal is a fixed number or another numeric field of the record). Display only, not stored, not in exports.
- **Statistics** (D-307, D-308): `goal` shows "value / goal" and the progress; `compare: "previous"` replaces the only period in the filter with the previous period of the same length and computes again.
- The AI only configures these properties and cannot see records or computed values (D-042, D-113).

## 20. Big circles and board (since D-311)

- **Big circles** (D-311, schemaVersion 27): `recordList.display: "tiles"`, one big circle per record; a tap runs this tile's row action (D-300), and when there is no row action it opens the record, and when there is a row action a long press opens the record (single-component edit gives way); `trailingFormat: progress` is drawn as a progress ring outside the circle. At most 24 are shown (D-312).
- **Board** (D-313, D-314): `recordList.display: "board"` + `groupField` (choice). One column per option plus "Not set"; dragging to another column, or tapping a card and choosing "Move to…", is equivalent to the `set` of a one-tap action and can be undone.
- The AI configures only the look and cannot see records (D-042, D-113); moving a card is a change the user makes themselves, written straight to the database like a form, without creating a version.

## 21. Pages for one record, date recognition on the device (since D-340)

- **Page for one record** (D-342, schemaVersion 30): the page's `recordOf` + the list's `opens`; `"$record"` in a component is replaced on the device with that record's ID when opened (`core/record-pages.ts`), the config holds only a placeholder value, and the AI cannot see the ID. The `values` of the quick-add form (D-343) can set a reference to it.
- **Date recognition on the device** (D-344): `core/date-phrases.ts` recognizes dates, times and repeats in the three languages by rules, and `core/smart-date.ts` converts them into the fields to fill. The `smartDate` of the quick-add form and the date box both recognize on the phone, and the text is not sent to the AI.

## 22. Segments, clock times, month calendar reading schedules, add in place (since D-346)

- **Clock time** (D-346, schemaVersion 31): the schedule rule's `time`, used by reminders sorted by record.
- **Segments** (D-347): `recordList.groupBy` + `groupUnit` + `showEmpty`, with the logic in `core/list-groups.ts`.
- **Month calendar reading schedules** (D-348): the month calendar's `dateField` can be a schedule, and the record lands on each upcoming occurrence.
- **Add in place** (D-349): `recordList.addHere` opens the form for a new record, preset with the values of this segment and the "equals" conditions in the list filter.
- **Board columns by reference** (D-351, schemaVersion 32): `groupField` can be a reference field, and `groupFilter` selects which columns to show.
- **Quick add as a bottom sheet** (D-352): `recordForm.mode: "sheet"`, the "+" at the bottom right of the page.

## 23. Detail pages, more periods, sort keys, reminders (since D-557)

All additive and optional: no schema version bump, no migration; an exported file lists each one in `uses.features` (D-556).

- **The opened entry in a `single` block** (D-558): on a page for one entry (`page.of`), a `single` block of the same table may write `source.record: "$record"` and then shows the opened entry, and its Edit button edits it. As with filters, the config holds only the placeholder; the id is put in on the device while drawing (`bindRecord`). Pictures in a file field listed in `show.fields` are drawn as pictures in every `single` block; other files stay a line of text.
- **Periods before and after the current one** (D-559): `yesterday`, `lastWeek`, `lastMonth`, `lastYear`, `tomorrow`, `nextWeek`, `nextMonth` are whole calendar days, weeks, months and years, following when a day and a week start (D-286). They work wherever a period does (filters, `in.records`, `file.filter`). The past four are also choices of the page `period` block. Compared with "the previous period", each is compared with the whole period right before it (last month with the month before, next month with this month).
- **Sorting by up to three fields** (D-560): a record block's `source.sort` is one `{field, direction}` as before, or a list of 1–3 of them: sorted by the first, ties by the next; empty values go last at every step; when all are equal, newest first. A field may appear once. When the user picks a field with `show.browse.sort`, that field sorts first and the configured keys follow for ties. The file block keeps one sort.
- **Record lists follow the page time range** (D-561): a record block (not a calendar) may write `source.period: "page"` like number and chart blocks (D-440). It needs a `period` block on the same page and cannot also have `show.browse.period`. While the page is drawn, the list keeps only the entries whose date falls in the picked range: the date field of the `inPeriod` in its filter (that `inPeriod` is then ignored), otherwise the table's first date field, otherwise the creation date. Nothing is written when the user picks. Removing the period block removes `source.period` from the lists too.
- **A reminder some minutes before a date and time** (D-562): `when: {before: {table, field}, minutes}` (1 to 10,080, seven days) on a datetime field plans one local notification per entry, that many minutes before its date and time; past ones are not planned. The text names only the table and the time (P-043 ②). It shares the cap on dated notifications (48, nearest first) and the system cap of 64. Nothing is written and nothing leaves the device.
- **A daily or weekly reminder that stays quiet when it is done** (D-563): `unless {table, within, filter?, date?}` (D-317) also works on `when.every` day or week; `link` is refused there (there is no entry). Such a reminder is not handed to the system as a repeating notification: the device plans its next 7 occurrences as dated notifications and leaves out each one whose day, week or month (by `within`, counted from the logical day of D-286) already has a matching entry. It is planned again whenever entries or the config change and whenever the app opens (`useReminderSync`); nothing runs in the background, so after 7 occurrences without opening the app it stops until the app is opened.
- **A reminder on a day of the month** (D-577): `when: {every: "month", day, at}` with `day` 1–28 (every month has these days). The system has no monthly repeating notification, so the device plans the next 7 occurrences as dated notifications, found by walking the next 366 days (they share the cap of 48 dated notifications), and plans again whenever entries or the config change and whenever the app opens; nothing runs in the background, so after 7 months without opening the app it stops until the app is opened. `unless` (D-563) works here too, with the same rules: no `link`, and `done` and `snoozeMinutes` stay `when.each` only.
- **A group that can be folded** (D-578): `show.fold: "open" | "closed"` on a group (it needs a `title`, which becomes the tap target). The value is how the group starts; folding is not stored and not a write.
- **A block shown only while some entries match** (D-579): `showIf: {table, has: "some" | "none", filter?}`; the optional `filter` (≤5 conditions, same as a list filter, computed fields allowed) narrows which entries count. Reading only: nothing is written or stored.
- **A callout** (D-580): look `callout`: `show {title, text, icon?, actionLabel?, openLabel?}`, `source {table, filter?}`, `tools?` (one record tool) and `opens?`. `{count}` and `{sum:<field>}` in `text` are worked out when it is drawn from the entries that match `source.filter`; nothing is stored.
- **Tap a bar to set the page range** (D-585): `show.pickPeriod: true` on a time-grouped bar or line chart: tapping a bar or point sets the page's time range (a `period` block with `custom: true` on the same page) to that day, week or month. It lives only in the page state; nothing is stored.
- **A check-in grid** (D-610): look `grid`: rows from `source.group.by` (a link field, one row per linked entry, `group.filter` narrowing that table, or a choice field, one row per option; `showEmpty`), columns from `source.across {unit: day | week | month, by?: a date or datetime field, last?: 2–31}` (the newest is the current day, week or month). A cell holds the entries of that row in that column; the count (or the sum of `show.trailing`) and a ring for `show.format progress` are worked out when it is drawn, never stored. A tap on an empty cell creates an entry with `values: "$here"` (the row value and the column's day); with a `remove` tap a cell with one entry is moved to Recently deleted with Undo, a cell with more lists them. Looking, scrolling and paging back write nothing.
- **The description says when a reminder stays quiet** (D-564): wherever a reminder's timing is described (Settings → Reminders, change descriptions), a reminder with `unless` gets a clause naming the table and the day, week or month ("…, unless “Expenses” already has an entry that day"); with a `filter` or `link` it says "a matching entry". Only names from the config appear, never filter values or entry content.

## 24. Option values and colours, formulas over checkboxes and choices, the entry form layout (since D-568)

All additive and optional: no schema version bump, no migration; an exported file lists each one in `uses.features` (D-556).

- **An option may carry a number and a colour** (D-568): `{id, label, value?, color?}`. `value` is any finite number the option stands for ("high" = 3, "monthly" = 12); only formulas read it, sorting stays by option order and statistics still count options. `color` is one of eight named colours (`red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `grey`) defined once in `core/option-colors.ts`, each with a light and a dark variant that reach the theme's text contrast on the default page and card colours; never a hex code. Wherever an option's colour is drawn (the dot of `show.color`, a calendar day, a pie chart grouped by the field) an option with `color` uses it and the others keep the colour of their order (`optionColor` in `core/chart.ts`). When at least one option of the field has a colour, the options without one take, in their order, the palette colours outside the hue families of the colours used in that field (each palette colour's families are declared once in `CHART_COLOR_FAMILIES`, next to the named colours; teal counts as green), so "transfer" is not a near-green next to a green "income"; when none is left they are neutral grey. When no option has a colour the by-order colours are exactly as before (D-571).
- **Formulas read checkboxes and choices** (D-569): `{done}` on a checkbox is 1 when ticked and 0 when not; an entry saved before the checkbox existed counts as 0, as it is shown unticked. `{cycle}` on a choice is the `value` of the chosen option; no option chosen, an option without a `value` or an option that was removed give no value, exactly like an empty number. No new syntax: comparisons stay the first part of `if`, so "still to pay" is `if({paid} = 1, 0, {amount})` or `{amount} * (1 - {paid})`, and "cost per year" is `{price} * {cycle}`. A formula over a choice none of whose options has a `value` is refused with a sentence telling the AI to give the options numbers. A lookup or `previous` of a checkbox or choice shows that field, so it reads the same way (the linked table's option values); a rollup still cannot sum, average or compare a checkbox or choice directly (they are not numbers for statistics), but it can sum a formula that reads one (`{paid}` summed is the number of paid entries). Statistics and charts over the fields themselves are unchanged.
- **The entry form is laid out by the config, in four ways only** (D-570, decided by the founder on 2026-11-16, decision ①). Saving, deleting, attachments, suggested values (prefill) and everything else about the entry page stay the kernel’s (the button row stays configured by `recordRow`, D-428).
  - _Sections_: a table may carry `form: {sections: [{title?, fields, when?}]}` (1–10 sections, 1–30 fields each, a field in at most one). Sections are drawn in order with their titles; fields not named in any section follow after them in table order, untitled, so adding a field never makes it unreachable and no check depends on listing everything. Removing a field takes it out of the sections (an empty section goes, and `form` goes when none is left) and out of their conditions (invariant 18).
  - _Conditional display_: `when` is 1–3 conditions (the usual filter shape, AND) on stored fields of the same entry, never on a field inside that section, a computed field or `createdAt` / `updatedAt`. The section shows while they hold for the values currently in the form, live as the user edits. Hiding clears nothing: a hidden section's stored values stay and come back when it shows again (invariant 5); the form does not hand in what was typed in a section that is hidden when saving; and `prepareRecordValues` does not report a required field of a hidden section (also for one-tap tools, which may still write such a field).
  - _Hint_: any stored field may carry `hint` (≤ 80 characters), drawn under its input in the entry form and in `form` blocks. It is config text like a field name, so the AI may write it; it never holds entry data.
  - _Range_: `min` / `max` on number, money and duration (minutes) fields. `prepareRecordValues` refuses a value outside them only when it changed, with `tooSmall` / `tooLarge` and the limit ("Must be at least 1."), so a stored value outside a range added later is still shown and the entry still saves. A one-tap `increment` that would leave the range writes nothing and says so ("Nothing was changed: “Quantity” can’t go above 5."), instead of opening the entry form as other refused taps do; `setAll` skips such entries as it skips any entry that cannot be saved.
  - _Refused save_ (D-572): the entry page marks each field with a problem under its input, as before, and when a save is refused it also says, right above the Save button at the bottom of the form, how many fields need attention and that they are marked above ("2 fields need attention; they are marked above.", three languages, singular and plural), because on a long form the marked field may be out of view. Editing a field clears its own error at once; the others stay until the next save. The page does not scroll to the field (that needs native measurement and was not verified on a device).
  - Only the full entry form (new and edit, and the quick action's "add an entry" form) uses sections and conditions; hints and ranges apply wherever the field is typed in. Lists and other blocks are untouched. The AI sets all four with `updateData` on the table or the field (prompt rule 64); such a change is a function change (D-191) and can be undone in Change history.

## 25. A row of choices on a page (since D-573)

Additive and optional: no schema version bump, no migration; an exported file lists `blocksFollowPageChoice` in `uses.features` (D-556); the new look is listed by itself.

- **The `choices` block** (D-573): `{look: "choices", source: {table, field}, show: {options?, all?: false, default?}}` names one choice field of a table. It draws a row of tabs: "All" first (unless `all: false`), then the field's options in their order, or the subset and order in `show.options`. `default` is the option picked when the page opens (otherwise "All", or the first option without "All"). When the field has an option with a colour (D-568), each tab gets a dot in that colour. At most one per page, on the page itself (not in a group).
- **Blocks that follow it**: a record block (any record look, the calendar included), a number block or a chart that reads the same table may write `source.choice: "page"`; while the page is drawn it shows only the entries whose field is the picked option, as if its filter had one more `is` condition; "All" adds nothing. A number's `minus` is not narrowed. A block reading another table, a block grouped by the same field (a board column per option, a pie or number grouped by it) and a list whose own `show.browse.filter` uses the same field are refused, with a sentence saying which key to remove. A block may follow both a `period` block and the choices block.
- **Nothing is written** (invariant 15): the pick lives in the page's state; option ids are config, not content (invariants 2 and 14). An Add under a following list (`"$here"`, D-349) starts the new entry with the picked option, and a list tool (`as: "list"`, D-428) hands over the entries the list shows, so only the picked option's.
- **Consistency** (invariant 18): removing the choices block takes `source.choice` off the blocks that followed it; removing its field removes the block (and then the key); removing the table removes it with the table's other blocks; removing an option drops it from `show.options` and `default` (when none is left, the row shows all options again).

## 26. Choice fields that pick several options (since D-607)

- **The field**: `{type: "choice", options, multiple: true, default?: optionId or [optionIds]}`. An entry stores a list of option IDs in option order; an empty list is not stored. Options stay in the config like any choice (invariants 2 and 14).
- **Reading**: an ID stored before `multiple` was turned on reads as a one-item list; IDs of options removed later are not shown or counted, but stay in the entry and never block saving it. Shown as the labels in option order joined by the list separator ("Monday, Thursday", "周一、周四").
- **Filters**: `is` with an option ID (or a list of them) keeps the entries that have any of them; `isNot` keeps those that have none; `isEmpty` / `isNotEmpty` as usual. The same everywhere conditions are read (block sources, rollup filters, reminders' unless, setAll, showIf, highlight, form sections).
- **Grouping**: list, cards and checklist sections, number blocks and bar charts grouped by it, a board (read-only) and the `choices` row put an entry under every option it has, so the counts can add up to more than the entries. Sorting uses the first option picked.
- **Refused**: a formula over it, `show.color`, a pie chart grouped by it, a board drag on it, a money `currencyField` and a previous `within` (each needs one option per entry). Lookups and `latest` rollups of it show and filter like the field.
- **Record tools**: `create`, `createAll`, `set` and `setAll` write a list of option IDs, which replaces what the entry had; one ID alone is refused on a multiple field (add or replace would be unclear).
- **Turning it on and off**: turning `multiple` on keeps every entry as it is. Turning it off is refused. If an undo or a restore brings back the single field, a stored list is still shown but reads as not set; saving another field keeps it, and picking an option replaces it.
- **Import and export**: CSV and sheet export write the labels with the list separator; import reads the labels (or IDs) separated by `,` `，` `、` `;` `；` and skips the row if one is not an option.
- **On-device suggestions** (D-398, D-575) leave a multiple field alone.
- **Schema**: version 40; the migration only raises the version.
