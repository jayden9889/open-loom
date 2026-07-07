## Loom Recording-Side Feature Inventory (verified July 2026, post-Atlassian acquisition; docs now on support.atlassian.com/loom)

### Surfaces / clients (each has different recorder capabilities)
Loom ships four recorders: **Chrome extension**, **Desktop app (macOS + Windows)**, **Mobile app (iOS + Android)**, and an in-browser web recorder. Feature parity is NOT equal - the desktop app is the most capable, the Chrome extension is second, mobile is most limited. [https://support.atlassian.com/loom/docs/choose-your-recording-mode/]

### Capture modes
Four modes exist (all available on both desktop app and Chrome extension): [https://support.atlassian.com/loom/docs/use-looms-different-capture-modes/]
- **Screen + Camera** - captures screen (or chosen window) plus the camera bubble overlay. The default hero mode users care about.
- **Screen only** - narrate over the screen, no camera bubble.
- **Camera only** - present straight to camera, no screen. IMPORTANT constraint: camera-only MUST be selected before recording starts - it cannot be switched to mid-recording. Camera-only recordings are capped at 720p regardless of plan. [quality doc]
- **Avatar mode** - camera-shy option that shows a personal avatar instead of the live camera feed. Desktop: hover the camera bubble → select the avatar icon. Chrome: turn off camera → select camera icon → choose avatar.
- **Mid-recording switching:** You can toggle between screen-only and screen+camera during a live recording via the camera icon in the recording controls (only if the recording menu/controls are enabled). Camera-only is the exception (pre-set only).
- **Screen capture scope (tab / window / full screen):** Chrome extension leans on the browser's native "Share your screen" picker offering Chrome Tab / Window / Entire Screen. Desktop app lets you pick full screen or a specific application window. (Tab-level capture is a browser/extension capability; desktop captures displays/windows.)

### Camera bubble
- **Three preset sizes** (small / medium / large) on BOTH Chrome extension and desktop - hover over the bubble and pick one of three sizes; changeable before or during recording. Not free-drag pixel resize - fixed presets. [https://support.atlassian.com/loom/docs/resize-your-camera-on-the-chrome-extension/]
- **Draggable/movable** around the screen; the bubble (and any frame) follows the new position.
- **Shape** is a circular bubble by default.
- **Frames** - decorative frames around the bubble. Desktop app ONLY; NOT available in Cam-only mode and NOT on the Chrome extension. Add via the effects icon. [https://support.loom.com/hc/en-us/articles/360014840018]
- **Virtual backgrounds** - preset images, blur, or solid colour; requires screen+camera mode, chosen via effects icon. Custom/user-uploaded backgrounds are NOT supported. Available on the free Starter plan. [https://support.atlassian.com/loom/docs/add-a-virtual-background-to-your-camera-bubble/]
- **Hide/show bubble mid-record** via the camera icon in the recording controls (this is how you switch screen+cam ↔ screen-only live).
- **Flip/mirror camera** (Chrome extension setting) - mirrors the image so on-screen text isn't reversed.
- **Auto lighting** (Chrome extension) - optimises lighting for a polished look.

### Mic / camera / audio selection
- Recorder lets you pick **camera source** and **audio (mic) source** before recording. [chrome settings doc]
- **System/computer audio** capture is supported and is available even on the **free Starter plan** (listed as a Starter feature on the pricing page). [https://www.loom.com/pricing]
- **Background noise suppression** - available on free Starter plan.
- Recording can start with mic and/or camera off (mic-off = silent screencast; camera-off routes toward avatar/screen-only).

### Countdown
- **"3, 2, 1" recording countdown** before capture begins. On the Chrome extension it's a toggle under More actions → "Recording Countdown." [https://support.atlassian.com/loom/docs/configure-your-recording-settings-chrome-extension/]

### Recording controls (control bar)
Control bar functions: start/stop, **pause/resume**, **cancel/restart (delete)**, camera toggle, mic toggle, drawing tool, timer/elapsed-time display, confetti. [https://support.atlassian.com/loom/docs/hide-the-recording-controls/]
- **Pause/resume:** desktop app + Chrome extension; on Chrome, Pause sits next to the camera bubble menu, or use the shortcut. [https://support.loom.com/hc/en-us/articles/360002235998]
- **Cancel/restart:** discard the current take and restart. "Quick Restart" is a dedicated shortcut.
- **Show/hide recording time** toggle (Chrome extension).
- **Hide recording controls:** Chrome ext - three-dot → Settings → disable "Recording controls" (then you MUST drive recording via keyboard shortcuts). Desktop - Settings → Enhance tab, three options: (1) hide only in final video [Windows 10+ ONLY - Macs cannot hide controls from the final recording], (2) hide while recording AND in final video, (3) show throughout. Mobile (Android) - Settings → toggle off "Floating recording controls." [hide-the-recording-controls doc]

### Drawing / annotation while recording
- **Drawing tool** - temporarily draw/highlight areas of the screen during recording; annotations are ephemeral. Shortcut Cmd/Ctrl+Shift+D. Gated to **Business, Business+AI, Enterprise** (and Education) - NOT on free Starter. Listed on pricing as "drawing tool & mouse emphasis." [pricing; keyboard shortcuts doc]
- **Confetti** effect - Ctrl+Cmd+C (Mac) / Ctrl+Alt+C (Windows).
- **Canvas / backdrop** - add a canvas/background behind the recording. [https://support.loom.com/hc/en-us/articles/4409195938193]
- **Blur effects** - obscure sensitive content; listed as a paid (Business+) recorder feature. [pricing]

### Click highlights (mouse emphasis)
- **Highlight mouse clicks** - visually emphasises where you click. **Desktop app ONLY** (NOT Chrome extension). Toggle: three-dot menu → Settings → Video & audio → "Highlight mouse clicks." Gated to **Education, Business, Business+AI, Enterprise** - NOT free Starter. [https://support.atlassian.com/loom/docs/highlight-your-mouse-clicks]

### Keyboard shortcuts (fully customisable in Settings) [https://support.atlassian.com/loom/docs/use-looms-keyboard-shortcuts/]
Desktop Mac / Windows:
- Start/Stop: Cmd+Shift+L / Ctrl+Shift+L
- Pause/Resume: Opt+Shift+P / Alt+Shift+P
- Cancel: Opt+Shift+C / Alt+Shift+C
- Quick Restart: Cmd+Shift+R / Ctrl+Shift+R
- Draw: Cmd+Shift+D / Ctrl+Shift+D
- Confetti: Ctrl+Cmd+C / Ctrl+Alt+C
- Full-screen screenshot: Cmd+Shift+1 / Ctrl+Shift+1
- Custom-size screenshot: Cmd+Shift+2 / Ctrl+Shift+2
Chrome extension Mac / Windows:
- Activate extension: Opt+Shift+L / Alt+Shift+L
- Pause/Resume: Opt+Shift+P / Alt+Shift+S
- Cancel: Opt+Shift+C / Alt+Shift+C
- Quick Restart: Opt+Shift+R / Alt+Shift+R
(No documented shortcut for mute-mic or hide-camera.)

### Recording length limits per plan [https://support.atlassian.com/loom/docs/how-long-can-i-record/]
- **Starter (free): 5-minute per-video cap.**
- **Business / Business+AI / Enterprise: unlimited recording length.**
- Chrome extension users get a **check-in prompt after 2 hours** of continuous recording (confirm intentional use) - applies regardless of plan.

### Video quality / resolution per plan [https://support.atlassian.com/loom/docs/manage-your-video-recording-quality/ ; https://www.loom.com/pricing]
- **Starter (free): up to 720p only.**
- **Business / Business+AI / Enterprise: HD up to 4K** (1080p = 1920x1080; 4K ≈ 3840x2160).
- **Desktop app: supports up to 4K** (device-dependent).
- **Chrome extension: max 1080p** even on paid plans (never 4K).
- **Camera-only recordings: capped at 720p** on all plans.
- Set via Settings → Video & Audio tab → Video quality dropdown; adjustable per-recording before start. HD needs device system requirements + fast internet.
- **Custom recording dimensions / custom-size video** - paid (Business+) feature; record a defined region. [pricing]

### Other recorder features
- **Do Not Disturb mode** - a paid Business+ recorder feature to suppress interruptions; note Loom does NOT auto-enable OS-level DND, users toggle Loom's DND. [pricing; https://support.loom.com/hc/en-us/articles/360002243957]
- **Speaker notes / teleprompter** - on-screen script while recording; available on free Starter. [pricing]
- **Screenshots** - full-screen and custom-size screenshot capture built into the desktop recorder (shortcuts above).
- **AI for Meetings recorder** - separate flow that records video meetings; /pause and /resume typed into meeting chat control it. [https://support.atlassian.com/loom/docs/record-meetings-with-loom-ai-for-meetings/]

### Plan-gating summary (recording side)
- **Free Starter:** screen+cam, all 4 capture modes, camera bubble (3 sizes, move, virtual backgrounds), system audio, noise suppression, countdown, speaker notes, pause/resume, screenshots. LIMITS: 5-min cap, 720p max, 25 videos/person.
- **Business+ (paid) unlocks:** unlimited length, up to 4K (1080p on Chrome ext), unlimited videos, drawing tool, mouse-click emphasis, blur, custom recording dimensions, Do Not Disturb, camera frames (desktop). 
- Mouse-click highlights and camera frames are additionally **desktop-app-only** even when the plan allows them.

### Platform difference cheat-sheet
- **Desktop app (most capable):** up to 4K, frames, mouse-click highlights, screenshots, full DND, hide-controls-in-final-video (Windows only).
- **Chrome extension:** max 1080p, native browser tab/window/screen picker, flip camera, auto-lighting, countdown toggle; NO frames, NO mouse-click highlights, NO 4K.
- **Mobile (iOS/Android):** screen + camera recording with floating controls (Android can toggle these off); most limited; no drawing/frames parity documented.