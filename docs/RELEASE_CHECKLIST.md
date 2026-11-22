# Before a release: by hand on a device

Unit tests and the simulator miss what only a release build on a real device does: native modules, R8, the camera, the share sheet, notifications and permissions. Go through this list on a release build before every store upload (`docs/RELEASE.md`), on one Android phone and one iPhone. Write down the commit, the devices and anything that failed, in the notes folder (not in git).

Start with the automatic smoke test on an Android emulator:

```bash
npm run smoke:android -- --apk apps/mobile/android/app/build/outputs/apk/release/app-release.apk --serial emulator-5570
```

It installs the APK and starts the app, checks that it stays up for 20 seconds with no crash or ANR in logcat, and saves a screenshot. Run it only against an emulator or a device you were asked to use.

Then, on each device:

1. **Fresh install and update** (core flow 1).
   - Steps: install on a device without Tinkrum; go through the intro; close and reopen. Then install the same build over an older one that has data.
   - Expect: the home page appears, and the rescue page does not. After the update, every record, file and app is still there.
2. **Tink changes the app** (core flow 1; needs the relay).
   - Steps: on the Tink page, ask for a look change and a feature change.
   - Expect:
     - The look change waits in a draft until "Apply".
     - The feature change takes effect at once.
     - Both appear in Change history and can be undone.
     - With the phone offline, Tink says it cannot reach the server, and everything else still works (invariant 13).
3. **Scan to PDF, Word and Excel** (core flow 2).
   - Steps: scan a curved, two-page document with the camera. Make a PDF, then a Word file and an Excel file from it. Save each to Files / "Save to phone".
   - Expect: the pages are straightened and flattened, the text is selectable, and the Word and Excel files open in the system viewer. On a fresh install with packs bundled, no download is asked for flattening.
4. **Share into Tinkrum** (core flow 3).
   - Steps: from Photos, share two photos to Tinkrum; from Files, share a PDF. Run the suggested quick action.
   - Expect: the inbox shows the files and suggests an action, and the result opens. The originals in Photos and Files are unchanged (invariant 4).
5. **Records** (core flow 4).
   - Steps: add, check, edit and delete entries in a list, a board and a calendar; undo the delete from the banner.
   - Expect: each write shows at once. Only the delete shows an undo banner, and undoing it brings the entry back.
6. **Reminders with the app closed** (core flow 4).
   - Steps: set a reminder two minutes ahead with a Done button; force-quit the app; tap Done on the notification. Repeat with "Remind me later".
   - Expect: Done updates the entry without opening the app; "Remind me later" fires again after the snooze. If it cannot save, a notification says "Not logged".
7. **Backup and restore** (core flow 4).
   - Steps: Settings → Data → Backup: export; restore the same file; undo the restore from the banner.
   - Expect: the restore brings back the same records, files and apps. The undo returns to the data from before the restore.
8. **Import an app file and a preset** (core flow 5).
   - Steps: import an app file made by another AI, then one preset from the presets page.
   - Expect: each becomes its own app, can be opened, and Tink can change it.
9. **Downloads, voice and the on-device model**.
   - Steps:
     - Download one OCR language and recognise a photo.
     - Download the speech model and transcribe a recording.
     - Make a new entry with an attachment, so that the on-device model suggests values.
   - Expect: each asks before downloading, shows the license, works offline afterwards, and sends nothing but the download request.
10. **Languages and system settings**.
    - Steps: switch the phone to French and then Chinese, and repeat step 1 and one other step. Turn on the largest system text size and open the home page, a new-entry form and the Tink page.
    - Expect: no English left on the main paths, nothing cut off, and the buttons still tappable.
