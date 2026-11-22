# Questions for the founder (P items)

Each is a question only the founder can settle, with the default applied meanwhile and what it blocks. How this log is organized: [DECISIONS.md](../DECISIONS.md).

### P-001 — Whether to require a CLA

**Default meanwhile:** Decided (2026-10-22): **external contributions are not accepted for now**; external PRs are closed directly, issues are welcome (see CONTRIBUTING.md). The CLA will be decided before contributions are opened in the future

**Blocks:** Opening to external contributions

### P-002 — Product name

**Default meanwhile:** Codename Morph

**Blocks:** Public release, trademark

### P-003 — App interface language

**Default meanwhile:** Copy is managed centrally; English and Simplified Chinese are provided first, following the system language

**Blocks:** Not blocking

### P-004 — List of protected elements

**Default meanwhile:** Decided (2026-10-22): only Settings, see D-031

**Blocks:** Not blocking

**Changed later by:** D-031.

### P-005 — Mock AI phrase list

**Default meanwhile:** Draft in [MOCK_AI_PHRASES.md](MOCK_AI_PHRASES.md)

**Blocks:** Not blocking (acceptance criteria)

### P-006 — PDF file size limit

**Default meanwhile:** PDF: 100MB per file, 200MB of PDFs in total per run (D-601, was 50 / 100); other files read whole into memory: 50MB per file, 100MB total; video and audio are counted separately: 4 GB per file, at most 10 at a time (D-142)

**Blocks:** Not blocking

**Changed later by:** D-142, D-601.

### P-007 — Naming template and time zone

**Default meanwhile:** `合并-{date:YYYY-MM-DD}` (literal Chinese template: "merged-" + date), device time zone, a sequence number is appended on a name collision

**Blocks:** Not blocking

### P-008 — First paid feature and pricing

**Default meanwhile:** Hosted AI + sync backup

**Blocks:** Monetization

### P-009 — In-app payment method on iOS

**Default meanwhile:** Not implemented for now

**Blocks:** Shipping paid features

### P-010 — Default model (the provider is decided: Claude; with your own key you can also pick an OpenAI-compatible endpoint, D-241)

**Default meanwhile:** Decided (2026-10-23, founder): **`claude-haiku-5-5`**, the default for both the server and "your own key"; always Haiku from now on; can be switched with `MORPH_AI_MODEL`. 2026-10-22 eval (22 cases): Haiku 5.5 / Sonnet 5.5 / Opus 5.5 all 22/22, about $0.0002 / $0.003 / $0.005 per change, all taking about 2–4 seconds

**Blocks:** Not blocking

### P-011 — Packs and App Store review rule 2.5.2 (no downloading executable code that changes app functionality)

**Default meanwhile:** Folded into D-177 (2026-10-24): the current packs are downloaded code; when step 2 goes live it switches to a signed catalog served as plugins per 4.7, and this item gets closed then. Until then, keep things as they are

**Blocks:** iOS App Store review

### P-012 — Whether to delete the scan pack and the text recognition pack now that iOS no longer needs them

**Default meanwhile:** Decided (2026-10-23, founder): **keep them**. Android's Russian recognition, edge detection for photos from the gallery, phones without Google Play services, and Expo Go all still need them (D-087)

**Blocks:** Not blocking

### P-014 — The app's bundle identifier / Android package name

**Default meanwhile:** Decided (2026-11-16, founder): `dev.stonetech.tinkrum` on iOS and Android, see D-553; local data in installs under the old placeholder `app.morph.mobile` is not carried over

**Blocks:** Store release, real-device install

**Changed later by:** D-553.

### P-015 — Additional AGPL permissions for ML Kit and store distribution

Additional permissions for the AGPL (ML Kit is closed source and is not a "system library" in the AGPL sense, D-087; app store terms also conflict with the AGPL)

**Default meanwhile:** Direction set 2026-11-16 (D-581), wording to a lawyer: keep LICENSE as the original AGPL text, and add `LICENSE-EXCEPTIONS.md` giving two additional permissions under AGPL section 7: (1) following the FSF FAQ template for "linking with libraries that are incompatible with the GPL", allow distribution after linking with Google ML Kit (Maven group `com.google.mlkit`) and Google Play services (`com.google.android.gms`), dropping the sentence that the corresponding source must include the library's source (the source of these two libraries is not available), and stating that it does not extend to other closed-source libraries; (2) following the approach of Feeel / wger, allow distribution through stores such as the App Store and Google Play whose terms conflict with the AGPL, provided the source is also offered under the AGPL on a channel without those restrictions. Anyone who redistributes can remove these two permissions (section 7 allows that anyway). The `license` field in package.json stays `AGPL-3.0-only`, and the License section of the README explains the additional permissions. Because there is a single copyright holder and no outside contributions are accepted (P-001), this can be added now; if contributions open up later, contributors must agree to these additional permissions. Also, ML Kit processes images on the device, but Google's terms allow it to report usage statistics, so the "not uploaded" wording in the privacy notice needs to be made more precise

**Blocks:** Android release and App Store release

### P-016 — Apple configuration for the share extension

**Default meanwhile:** Default: the App Group `group.dev.stonetech.tinkrum` and the extension bundle id `dev.stonetech.tinkrum.share-extension` follow the bundle id of D-553 (the plugin derives them from `ios.bundleIdentifier` in app.json). Before real-device testing and store release, register this App Group in the Apple developer account, enable the App Groups capability for both the main app and the extension, and sign them (not needed on the simulator)

**Blocks:** Real-device testing, App Store release

### P-017 — What content "Share to Morph" accepts

**Default meanwhile:** Default: files only: photos, videos, PDFs, any file (on iOS up to 50 photos and files each and up to 10 videos; on Android `image/*`, `video/*`, `audio/*` and `application/*`, D-144). Not accepted: text and URLs (they could feed workflows that start with "Enter text", for example generating a QR code, but that needs more design). Also, images saved to Morph files do not show up in the "Recent files" list, same as images saved by workflows (D-051)

**Blocks:** Not blocking

**Changed later by:** D-144.

### P-018 — Whether "Send photos in bulk" should drop the ZIP and share multiple photos at once instead

**Default meanwhile:** Decided (2026-10-23, founder): **keep the ZIP**. To send photos directly, remove the "pack" step in the edit page, or use "Email photos / Upload to a website" (D-122)

**Changed later by:** D-122.

### P-019 — Whether "Save to a folder" should remember the last folder chosen and stop asking

**Default meanwhile:** Decided (2026-10-23, founder): **remember it**, see D-123. Calling a cloud-drive API directly or sending to contacts automatically (anything that needs the network) is still not done (D-121)

**Changed later by:** D-123.

### P-020 — Whether to support MP3 output (requires bringing in the LGPL LAME library, which can only be statically linked on iOS)

**Default meanwhile:** Decided (2026-10-24, founder): **do it**, see D-183

**Changed later by:** D-183.

### P-021 — Whether to keep the audio scenario groups separate

Names of the audio scenario groups: keep "Study and work" and "Send audio" as separate groups, or merge them with "Send photos and videos" into "Send to others"

**Default meanwhile:** Default: **keep separate** (option Q6)

### P-022 — Which model Android speech-to-text uses by default

**Default meanwhile:** Default: **whisper small**, with a "faster" option, base. On a Samsung real device: one hour of recording takes about 30 minutes with small and about 12 minutes with base; word error rate on human reading 8% vs 14%. Recommendation: still default to small, and let users switch away when the recognition batch is built next (MVP_SCOPE real-device measurement)

### P-023 — Whether Android recording requests notification permission

Whether Android recording should request the notification permission (from Android 13, when notifications are not allowed, the "recording" notification does not show on the lock screen)

**Default meanwhile:** Default: **do not request**: recording continues as usual and the status bar shows the system microphone dot (since D-161, the first time a long video or audio task runs the app asks once for notification permission, and if allowed the recording notification also shows); on a Samsung real device a 1 hour 23 minute lock-screen recording did not break; recommendation is to keep this (MVP_SCOPE real-device measurement)

### P-024 — How the free hosted AI quota identifies a phone, and whether self-compiled apps can use it

**Default meanwhile:** Direction decided (2026-10-23, founder), **to be implemented before store release**: the free quota goes only to the official app that passes device attestation (iOS App Attest, Android Play Integrity); self-compiled apps use their own Claude key (D-028) or a self-hosted `apps/api`; the README and terms of service state that "hosted AI is for the official app only" (to be reviewed by a lawyer together with P-015). Usage is counted per attested real phone and does not reset on reinstall: on iOS use the 2 bits of DeviceCheck; on Android use Play Integrity device recall (beta, verify before implementing) or ANDROID_ID + an integrity attestation. Sideloaded test builds cannot pass Play Integrity, so during development the server keeps an allowlist of the founder's devices. Later, once accounts are connected, metering becomes per user (CLOUD_DESIGN §7) and the client token of D-132 is removed. An anonymous quota cannot stop mass abuse from many real phones, so without sign-in only a small amount is given

**Blocks:** Monetization; requires the Google Play testing track and TestFlight first

### P-025 — Removing and adding PDF passwords on Android (D-194)

**Default meanwhile:** Decided (2026-10-24, founder): take the default, which is to **do iOS only first**: the Android system has no API for reading or writing encrypted PDFs; adding PdfBox-Android (Apache-2.0, compatible with the AGPL, makes the install package larger, by how much must be measured) is required; until then Android reports "not supported" before running

**Blocks:** Android feature parity with iOS

**Changed later by:** D-194.

### P-026 — Whether PDF passwords and Wi-Fi passwords can be remembered (D-194, D-199)

**Default meanwhile:** Decided (2026-10-24, founder): take the default, which is **do not remember**, ask on every run; the alternative is to store them in the system keychain, remembered per quick action, so it does not ask next time (more convenient, but one more piece of data to protect, and it also has to be considered when changing phones or syncing)

**Blocks:** Not blocking

**Changed later by:** D-194.

### P-027 — What to do with PDFs that open without a password but restrict only printing / copying / editing (D-194)

**Default meanwhile:** Decided (2026-10-24, founder): take the default, which is **do not remove restrictions**: other PDF actions that meet such a file still report `encrypted` and explain why; the alternative is to treat it as a normal PDF like iLovePDF does (more useful, but removing restrictions set by the author raises copyright and store-terms concerns)

**Blocks:** Not blocking

**Changed later by:** D-194.

### P-028 — Which text a searchable PDF can write in the first version (D-195)

**Default meanwhile:** Decided (2026-10-24, founder): take the default, which is **Latin letters only** (English, French, German, Italian, Spanish, Portuguese and other Western European languages): the invisible text layer also needs a font, and the Helvetica bundled with pdf-lib can only write these; lines in Chinese, Japanese, Russian and so on are skipped for now, the PDF is generated as usual but cannot be searched for them. Later, switching to native text drawing (iOS Core Text, Android Canvas) would support all scripts, at a somewhat larger effort. On 2026-10-28 the founder asked to add Chinese, Japanese and Korean: D-266 writes all text with a glyph-less font, so native text drawing is not needed

**Blocks:** Searchable scans in Chinese, Russian and so on

**Changed later by:** D-195, D-266.

### P-029 — Make "Save to a folder" remember a folder per quick action (D-196, changes the founder's decision in D-123)

**Default meanwhile:** Decided (2026-10-24, founder): take the default, which is **remember per quick action**: the first time, reuse the folder chosen last; users notice no change until they use "Other folder" in some quick action; the alternative is to keep one folder for the whole app and let users set one for a particular quick action in the edit page

**Blocks:** Not blocking

**Changed later by:** D-196.

### P-030 — What to do with the old file after "Append to an existing file" (D-197)

**Default meanwhile:** Decided (2026-10-24, founder): take the default, which is **keep it**, the merged result is a new file (Morph does not delete user files without a prompt); the alternative is to add "Delete the previous one" on the result page, which the user has to tap themselves

**Blocks:** Not blocking

**Changed later by:** D-197.

### P-031 — App lock: how long away before verification is required on return (D-198)

**Default meanwhile:** Decided (2026-10-24, founder): **no App lock for now** (D-198); decide this time when it is built later; the original default was 1 minute, changeable to "every time" or "5 minutes"

**Blocks:** Not blocking

**Changed later by:** D-198.

### P-032 — Ordering and filling of inbox recommendations (D-208)

**Default meanwhile:** Default: count successes without a time limit, ties broken by most recent start time, descending; at most 5. If fewer than 3 have been used, fill up to 5 with the user's own, then presets not yet added, then tool features. Ones that were used but do not fit the file count show the reason and cannot be run; ones never used are not shown. "View all" expands on this page first

**Blocks:** Not blocking

### P-033 — Granularity of the inbox file list and statistics (D-208)

**Default meanwhile:** Default: a one-line summary, tap to open the file list, keep the note about on-device processing. No input-type database column is added; the same quick action is counted in total across file types

**Blocks:** Not blocking

### P-034 — Home page and entry layout for existing users (D-209)

**Default meanwhile:** Default: the entry is not added automatically to existing users' home pages; it can be added with AI. For new users, two choice buttons sit side by side under the title; the rest of the home page is in D-223 (confirmed by the founder 2026-10-25: no quick actions). The simulator layout is still to be verified

**Blocks:** Not blocking

### P-035 — Gain and peak limit for volume adjustment (D-217)

**Default meanwhile:** Default: automatic target −16 LUFS, amplify by at most 24 dB; manual ±24 dB. To avoid clipping, gain is limited by a −1 dBFS sample peak, so highly dynamic content may not reach the target. Silence is not amplified, and clips shorter than the measurement window are not auto-amplified

**Blocks:** Not blocking

### P-036 — Default ranges for image color adjustment (D-220)

**Default meanwhile:** Default: brightness −100–100, 0 is unchanged; contrast and saturation 0–200, 100 is unchanged. The brighten preset is +15. Auto does not change the size, and the two platforms do not promise identical results

**Blocks:** Not blocking

### P-037 — Language of the built-in mock rules in the French UI

**Default meanwhile:** As handed off: no French parser is added. Development/offline mode uses English examples, phrasing and rule replies; the real AI outputs French when the UI is French. Exception for the onboarding guide: the French guide is handed to the AI in Settings (D-228)

**Blocks:** Not blocking

**Changed later by:** D-228.

### P-038 — Whether to keep the scenario subheadings in category pages (getting documents abroad, expense claims...)

**Default meanwhile:** Default: **remove them** (handoff document §9, item 8): within each category, order only as "make your own → mine → ready-made → built into tools"

**Blocks:** Not blocking

### P-039 — Toolbar and other components in single-component editing

**Default meanwhile:** Default: show "Edit / Done" next to the selected item; other components are at about 0.5 opacity and cannot be tapped to run; a long press can still change the selected item, and the same draft keeps accumulating. While dragging, the toolbar is hidden temporarily and returns on release. An empty group keeps a 44pt drop zone

**Blocks:** Device gesture and layout acceptance

### P-040 — Haptics and the whole-page edit entry

**Default meanwhile:** Default: no expo-haptics, no native dependency added, no haptics; the page "Edit" button stays off, and the whole-page ArrangeView code and its tests are kept

**Blocks:** Not blocking

### P-041 — How long test requests are kept and how deletion works

How long requests saved during testing (D-240) are kept, how users ask for deletion, and whether they are still stored after the store release

**Default meanwhile:** Default: no automatic deletion for now; the files are only on the Mac mini and the founder views them manually. When a user asks for deletion, they can only be found by the hash of the device id (the user has to supply the device id, which is currently not visible in the app). Must be decided before the store release and before the privacy policy goes live

**Blocks:** Store release, privacy policy

### P-042 — Whether to allow plain http on the LAN (a phone connecting to Ollama / LM Studio on a Mac) (D-241)

**Default meanwhile:** Default: not allowed; the address must be https, and http is allowed only for the local machine. Supporting it would require native configuration changes: Android release builds block cleartext requests by default, so `usesCleartextTraffic` would have to be enabled (the network security config cannot allow by IP range), and iOS needs `NSAllowsLocalNetworking` plus a local network permission description; also the key would travel in plain text over Wi-Fi. For now, ask users to put an https address in front of their on-device model (Tailscale Serve, Cloudflare Tunnel)

**Blocks:** Not blocking

### P-043 — How reminders (D-251) relate to the "no automatic running" principle

**Default meanwhile:** Decided (2026-10-26, confirmed by the founder in a Claude Code session): (1) A reminder is only a local notification; tapping it just opens a page or a quick action, and a quick action runs only after the user taps "Start" again; the inbox and the run page do not run automatically because of a reminder, and there is no "run a quick action automatically when due". (2) Due reminders appear on the lock screen, and the body text contains only the table name, not the entry's title

**Blocks:** Not blocking

### P-044 — Maximum formula length (D-281)

**Default meanwhile:** Default 500 characters (was 200), and the prompt also says 500

**Blocks:** Not blocking

### P-045 — Maximum nesting depth of lookup, rollup and previous-entry (D-290)

**Default meanwhile:** Decided (confirmed by the founder, 2026-10-29, main session): 3 levels (formulas do not count as a level); exceeding it makes the check report an error

**Blocks:** Not blocking

**Changed later by:** D-290.

### P-046 — Colors for a month calendar colored by single-select (D-305)

**Default meanwhile:** Default: use the chart's category colors (blue, orange, green...) in the order of the options, not by meaning (happy is not necessarily green); coloring by meaning would require each option to have a selectable color (changing the structure of the single-select field)

**Blocks:** Not blocking; since D-568 an option may carry its own colour

### P-047 — Period comparison span and progress on record pages

Whether to compare against the previous period over the same span or the whole period; whether elapsed / progress should also show on the record page (D-306, D-308)

**Default meanwhile:** Default: **same span** (days 1–29 of this month against days 1–29 of last month); the record page **does not show** them, only lists do

**Blocks:** Not blocking

### P-048 — How many big circle blocks to show at most (D-312)

**Default meanwhile:** Decided (founder, confirmed 2026-10-30 in the popular-app-feature-cloning session): default 24; the rest are not drawn and check does not report an error

**Blocks:** Not blocking

### P-049 — How many reminders scheduled per record at most (D-319)

**Default meanwhile:** Default 40 (the system allows 64 in total, leaving the rest for daily, weekly and due reminders); the nearest ones are scheduled first, and later ones are filled in at the next rescheduling

**Blocks:** Not blocking

### P-050 — Whether reminder notifications use the record's title

The notification title of reminders scheduled per record uses the record's title (D-316), which conflicts with P-043 (2) "the lock screen shows only the table name"

**Default meanwhile:** Default: use the record's title (without it you cannot tell which habit or which plant it is, and "Done" would not tell you which one you tapped); the title is composed on the device and the AI cannot see it. Whether to hide it on the lock screen is up to the system's "Show previews" setting (on iOS the default is to show only after unlocking). If you disagree, change it to the table name only

**Blocks:** Not blocking

### P-051 — A few simplifications for widgets (D-323, D-325)

**Default meanwhile:** Default: rows in the list look only open the record (checkboxes of a checklist cannot be tapped on the widget, tiles can); tapping on a widget shows no banner and cannot be undone there, and everything is undone together after opening the app; when several kinds are tapped mixed together it shows "Updates after you open Morph"; the AI cannot add the "Put on home screen" entry

**Blocks:** Not blocking
