# Screen sharing privacy: implementation status

The Google Docs WebContentsView is shown only when Electron reports that content protection is enabled on a supported platform; otherwise it stays at zero size. There is no manual confirmation step (it was removed at the owner's request), so nothing in the app records that a remote participant's view was checked. Exclusion remains unverified until the checks below are done.

## Electron capability

`BrowserWindow.setContentProtection(true)` is applied before the first window is shown when Electron reports a supported platform/OS combination.

- **Windows 10 2004 (build 19041) and later:** Electron uses `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. The API takes effect on a subsequent desktop composition, so a just-started capture may race it. This protects against specific OS capture paths, not every possible recorder or camera.
- **Earlier Windows:** Electron documents black-window behavior, not exclusion. The app keeps assistance locked.
- **macOS:** Electron sets `NSWindowSharingNone`, but its docs warn that newer apps using ScreenCaptureKit can capture the protected window. The app keeps assistance locked pending a stronger, tested integration.
- **Linux:** Electron does not support `setContentProtection`; the app keeps assistance locked.

`isContentProtected()` reports Electron's configured state only. It does not inspect Meet, Teams, Zoom, browser-tab sharing, the selected monitor, or the stream seen by other participants, and the app does not infer a verified status from it.

## Google Docs tab

The live document is displayed in an isolated Electron `WebContentsView`, not an iframe and not the app's privileged local renderer. It accepts only HTTPS Google Docs document links, opens the normal live Docs `/edit` client, denies pop-up windows and browser permission requests, and keeps the view at zero size unless content protection is enabled and the document tab is active in the expanded window. The native parent window receives content protection before either renderer is shown. Drive sharing permissions are still authoritative: grant the representative **Viewer** access and the developer **Editor** access so the Google Docs page stays read-only for the app. “Anyone with the link · Viewer” is suitable for low-friction sharing; “Public” can permit search discovery. Do not treat a public doc as a private room.

The remote Docs page runs Chromium content, so its WebContentsView has Node integration disabled, context isolation, sandboxing, and web security enabled. These settings reduce privileges; they do not turn public content into trusted content or guarantee capture privacy.

## Required release verification

For every OS version and Electron version we claim to support, run a real meeting and inspect both local and remote views for:

1. Whole-desktop sharing.
2. Sharing the meeting application window.
3. Sharing a browser tab.
4. Switching applications during a share.
5. Moving the overlay across monitors.
6. New messages and notifications while sharing.
7. Live captions and AI response display while sharing.
8. Starting and stopping the share while the overlay is open.

Repeat with Google Meet, Microsoft Teams, and Zoom, including their browser and desktop clients where available. Record OS build, app/client version, share surface, and the remote result. Until that evidence exists, do not describe any configuration as guaranteed private. Local captions show transcript text inside the same protected window, so they are only as hidden from a share as that window is; caption audio and text are not sent over the network. The Ask AI tab is still a placeholder, and there is no meeting, developer-message, or notification integration.
