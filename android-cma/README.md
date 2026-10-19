# CMA Revision (Android)

An offline Android study app built around the CMA Part 2 revision deck, with
sign-in, a persistent score tracker, and mark-for-review for questions and
flashcards. It is designed for a single phone that you may lend to someone to
study on — so it also supports **screen-pinning** to lock the phone to the quiz
before you hand it over.

## What it does

- **Offline content.** The full revision deck (summaries, MCQs, flashcards,
  mock test, calculators, formula index, glossary) is bundled as an app asset —
  no internet needed to study.
- **Sign-in + auto sign-in.** First launch asks for a password; a token is
  stored in `EncryptedSharedPreferences`, so later launches go straight in.
  With no backend configured, the first password you set becomes this phone's
  study password.
- **Score tracker.** Every answered MCQ is recorded per user (section, correct/
  total) in a local Room database and summarised in the owner area.
- **Mark for review.** Tap the ☆ on any question or flashcard to flag it; a
  floating "★ Review (n)" panel lists everything you've marked. Flags are kept
  in the WebView and mirrored into the database.
- **Owner area (PIN-gated).** Reachable only via the small ⚙ button + an owner
  PIN. Shows *your own* study stats and lets you point the app at a backend.
  Invisible to anyone you lend the phone to.
- **Lock to quiz (screen pinning).** Owner → "Lock phone to quiz" calls Android
  screen pinning so a borrower can't leave the quiz or open your other apps.
  Owner → "Unlock phone" (after the PIN) releases it.

### Deliberately NOT included

This app does not read other apps' notifications, track anyone in the
background, or upload photos. Those were in the original brief but amount to
covert monitoring of whoever holds the phone, so they are not built. For the
two legitimate needs behind them:

- **Locating the phone when lent out** → use Android's built-in **Find My
  Device** (https://www.google.com/android/find). It's transparent, reliable,
  and works even when this app is closed.
- **Stopping a borrower reaching your other data** → that's exactly what the
  **Lock to quiz** screen-pinning feature above is for.

## Build

Needs the Android SDK (platform 34, build-tools 34). Easiest is Android Studio:

1. Open this `android-cma/` folder in Android Studio.
2. Let it sync Gradle, then **Run** (or Build → Build APK(s)).

Command line (with `ANDROID_HOME` set and `local.properties` containing
`sdk.dir=/path/to/sdk`):

```bash
./gradlew assembleDebug
# output: app/build/outputs/apk/debug/app-debug.apk
```

Install the APK by sideloading it onto the phone (enable "Install unknown apps"
for your file manager / browser).

## First-run setup on the phone

1. Launch, set a study password (used for auto sign-in).
2. Tap ⚙ (bottom-left), set an **owner PIN** — keep this private.
3. Before lending: ⚙ → owner PIN → **Lock phone to quiz**.
4. To get it back: ⚙ → owner PIN → **Unlock phone** (while pinned, use the
   Android unpin gesture — hold Back + Overview — then re-enter via ⚙).

## Backend (optional)

By default everything stays on the phone (`LocalOnlyCloudClient`). To sync the
signed-in user's own scores and review flags to a server, open the owner area
and set a **Base URL** (+ optional API key). The REST contract
(`RestCloudClient`) is:

```
POST {base}/auth/login      {username, password}  -> { "token": "..." }
POST {base}/ingest/reviews  [ {owner,key,kind,label,markedAt,cleared}, ... ]
POST {base}/ingest/scores   [ {owner,section,correct,total,recordedAt}, ... ]
```

Auth is sent as `Authorization: Bearer <apiKey>`. Adjust paths/payloads in
`cloud/RestCloudClient.kt` to match your backend.

## Project layout

```
app/src/main/
  assets/deck/index.html     the revision deck (licence gate neutralised;
                             the app's own sign-in is the gate now)
  assets/web/deckbridge.js   injected after load: score capture + mark-for-review
  java/com/arunsasi/cma/
    ui/        MainActivity (WebView host), LoginActivity, OwnerActivity
    web/       JsBridge (window.CMA)
    data/      Room: ReviewMark, ScoreEvent + DAOs
    auth/      SessionManager (encrypted session, study password, owner PIN)
    cloud/     CloudClient seam: LocalOnly (default) + Rest
    sync/      SyncManager (best-effort push of your own study data)
```
