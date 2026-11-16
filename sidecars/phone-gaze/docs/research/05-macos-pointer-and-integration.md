# 05: Delivering gaze on macOS: cursor, permissions, overlay, Forsee

Research note for the Core (`outputs/`, hotkeys) and UI owners and for whoever writes the Forsee
WebSocket source. Written 2026-11-16.

**How sure is this note?** Apple developer documentation pages, PyPI and GitHub were readable.
`support.apple.com`, `www.apple.com`, `talonvoice.com` and `pynput.readthedocs.io` were blocked
from this session, so claims about those come from search snippets and are marked _(unverified)_.
Nothing here was run on a Mac.

## 1. Moving the system cursor from Python

Two Quartz calls, both reachable through PyObjC (`pyobjc-framework-Quartz` 13.0 on PyPI):

| Call                                                                                    | What happens                                                                                                                                                                                                                                                               | Permission                                                                                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(None, kCGEventMouseMoved, pt, 0))` | A real mouse-moved event enters the HID stream. Apps see hover, tooltips, `:hover` CSS, `pointermove`. This is what pynput does ([`_darwin.py`](https://github.com/moses-palmer/pynput/blob/master/lib/pynput/mouse/_darwin.py)).                                          | Accessibility (posting events needs it since 10.14, [forum](https://developer.apple.com/forums/thread/103992)) |
| `CGWarpMouseCursorPosition(pt)`                                                         | "Moves the mouse cursor without generating events" ([docs](<https://developer.apple.com/documentation/coregraphics/cgwarpmousecursorposition(_:)>)). Apps do not see hover until the next real event. Reported not to register while the Zoom accessibility feature is on. | Not documented as needing any _(unverified)_                                                                   |

After a warp, macOS suppresses local hardware mouse events for a short interval (0.25 s by default
per the CGRemoteOperation header; `CGEventSourceSetLocalEventsSuppressionInterval` changes it)
_(from memory of the header; the doc page was a 404)_. At 30-60 Hz gaze updates that would fight
the real mouse, so posting events is the better default.

**Coordinates.** Quartz global display space is in **points**, origin at the top-left of the main
display, y down, other displays at offsets (possibly negative) given by `CGDisplayBounds(id)`.
Cocoa (`NSEvent.mouseLocation`, `NSScreen.frame`) uses the same points but with origin
**bottom-left**; pynput converts with `CGDisplayPixelsHigh(0) - y`. On Retina, one point is 2
backing pixels (`CGDisplayModeGetPixelWidth` vs `CGDisplayModeGetWidth`); never send pixels to
these calls. The engine's `ScreenInfo` (main display, top-left origin, points) maps directly onto
Quartz space with no conversion for the main display.

**Permissions for a Terminal-launched `python`.** TCC attributes the request to the _responsible_
app, i.e. Terminal, iTerm or the IDE, so that app is what must be ticked in System Settings →
Privacy & Security.

- **Accessibility** (posting events, `NSEvent` global key monitors): check with
  `AXIsProcessTrusted()`, or `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: True})`
  to show the system prompt; on 10.15+ also `CGPreflightPostEventAccess()` /
  `CGRequestPostEventAccess()` ([docs](<https://developer.apple.com/documentation/coregraphics/cgpreflightposteventaccess()>)).
- **Input Monitoring** (a `CGEventTap` that listens to the keyboard, which is how pynput's
  listeners work): check with `CGPreflightListenEventAccess()` or `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)` (10.15+).
  pynput exposes `Listener.IS_TRUSTED`, which only calls `AXIsProcessTrusted`.
- A changed Python binary (new venv, Homebrew upgrade) does not reset the Terminal grant, because
  the grant is on Terminal. The engine should report all three booleans in `/api/status` and the
  UI should show which one is missing.

## 2. pynput and alternatives

pynput 1.8.2 (latest on PyPI). Mouse control is a thin `CGEventPost` wrapper and is fine. Its
keyboard listener and `GlobalHotKeys` use a session event tap plus Carbon text-input calls on a
background thread; on recent macOS those calls assert they run on the main queue, and projects
report crashes on macOS 26 with Python 3.14 ([example report](https://github.com/moses-palmer/pynput/issues/510),
[similar rdev crash](https://github.xiaohuzi123231346.workers.dev/tinyhumansai/openhuman/issues/2677))
_(not reproduced)_. It also needs Input Monitoring.

Better for hotkeys: Carbon `RegisterEventHotKey`, which needs **no permission at all** and only
receives the registered chord. [`quickmachotkey`](https://github.com/glyph/QuickMacHotKey)
(2025.7.28, by Glyph) wraps it for PyObjC and must run on the main thread's run loop. Since
macOS 15, a hotkey whose modifiers are only Option and/or Shift fails with error −9868; at least
one of Command or Control is required ([Apple forum 763878](https://developer.apple.com/forums/thread/763878)).

## 3. Click-through overlay from Python

PyObjC `NSWindow` (`pyobjc-framework-Cocoa` 13.0): borderless style mask, `setOpaque_(False)`,
`setBackgroundColor_(NSColor.clearColor())`, `setIgnoresMouseEvents_(True)` (click-through),
`setLevel_(NSStatusWindowLevel)` or higher, collection behaviour `CanJoinAllSpaces |
Stationary | FullScreenAuxiliary | IgnoresCycle`, one window per `NSScreen`. Draw a small ring
in a custom `NSView` and move it, rather than redrawing a full-screen layer. AppKit must own the
main thread (`NSApplication.sharedApplication().run()`), so the asyncio engine runs on a worker
thread and posts UI updates with `performSelectorOnMainThread`. An overlay needs no permission.
A gaze dot drawn by the overlay is also the safe default when Accessibility is not yet granted.

## 4. Physical display size

`CGDisplayScreenSize(id)` returns millimetres from EDID; without EDID it **falls back to
2.835 px/mm (72 dpi)** from the pixel bounds
([docs](<https://developer.apple.com/documentation/coregraphics/cgdisplayscreensize(_:)>)). Built-in
Apple panels are reliable; external monitors sometimes ship wrong EDID (one report: 160×90 mm for
a 474×296 mm panel, [Arch forum](https://bbs.archlinux.org/viewtopic.php?id=239789)). Sanity check:
diagonal between 250 and 1500 mm and implied density between 2.5 and 12 px/mm (points), otherwise
flag it in the UI and let calibration's geometric fit override it.

## 5. System-level gaze input on macOS

- **HID page 0x12 "Eye and Head Trackers"** exists in the USB HID usage tables
  ([RIOT header](https://doc.riot-os.org/group__usb__hid__usage.html), [usb.org/hid](https://usb.org/hid)).
  Windows consumes it; I found **no evidence macOS does**. Apple's eye-tracker support for
  third-party hardware is iPadOS (TD Pilot, iPadOS 15), and on-device Eye Tracking is iOS/iPadOS 18
  only. The May 2026 accessibility announcement adds eye features to Vision Pro, not Mac
  _(snippets only)_.
- **Built in on Mac:** Head Pointer (camera head tracking), Dwell Control (via the Accessibility
  Keyboard, "using eye- or head-tracking technology") and Switch Control. All consume an ordinary
  pointer; none accepts gaze samples _(Apple support pages blocked)_.
- **Virtual HID device:** needs `com.apple.developer.hid.virtual.device` (CoreHID) or a DriverKit
  extension with Apple-granted entitlements; developers report requests pending 2.5 months
  ([forum](https://developer.apple.com/forums/thread/845599)). The only practical route is the
  signed, open-source [Karabiner-DriverKit-VirtualHIDDevice](https://github.com/pqrs-org/Karabiner-DriverKit-VirtualHIDDevice)
  (virtual keyboard and mouse, macOS 13-15 listed), which needs a root daemon and offers no
  advantage over `CGEventPost` for absolute positioning. Not worth it.

## 6. How others do it

- **Talon** supports Tobii 4C/5 on macOS 10.13+ with several "control mouse" algorithms, moving
  the system cursor itself and needing Accessibility _(docs blocked; search snippets)_.
- **Eyeware Beam** lists macOS as supported with macOS in beta since 2.6.3; its mouse feature is
  pointer control across screens ([release notes](https://assets.eyeware.tech/beam/builds/2.06.0003/53112/beta/release-notes-en_US.html)).
- Pattern: every Mac tracker moves the real cursor with synthetic events and keeps gaze data in
  its own process or SDK.

## 7. What Forsee's WebSocket source needs

From `packages/plugin-api/src/gaze.ts` and `packages/gaze-web/src/contracts.ts`
(`WebSocketSourceOptions`: loopback-only `url`, default setting `ws://127.0.0.1:47800`; `id`;
`reconnectMs`). The driver protocol document (`sidecars/PROTOCOL.md`) is **not written yet**, so
phone-gaze defines its side and the B2 owner should adopt or adapt it. Each `GazeSample` needs:

- `x`, `y` in **app viewport CSS pixels**. The engine only knows screen points, so the source must
  convert: send screen points plus a `screen` id, and let the app subtract the viewport's screen
  origin (`window.screenX` + chrome offset, or the desktop host's window frame) and divide by page
  zoom. Off-viewport values are allowed.
- `t` in the **host's** monotonic ms when observed: send the engine's capture time and latency;
  the source restamps as `clock.now() - (engineNow - engineCaptureT)`, keeping it non-decreasing.
- `confidence` 0..1 and `valid` (false on blink or face lost); never send `press` for gaze.
- `kind: 'gaze'` (raw, unsmoothed or lightly filtered; Forsee does its own dwell),
  `capabilities.hover: true`, `capabilities.calibrate`: true only if the engine implements
  `calibrate()` by receiving `CalibrationPoint`s and replying when data is collected.
- Errors map to `SourceError.code`: `disconnected` (recoverable), `calibration-required`,
  `unavailable`.

## What to build

1. **Default output: WebSocket gaze stream** on `127.0.0.1:47800`, JSON per sample `{type:
"sample", x, y, screen, tEngine, latencyMs, confidence, valid}` in main-display points, plus
   `hello` (screen list with point bounds, mm sizes, scale) and `status`. No permission needed.
2. **Overlay gaze dot** (PyObjC, click-through, all Spaces), on by default; no permission.
3. **System cursor, opt-in:** `CGEventPost` mouse-moved at `kCGHIDEventTap`, rate-limited to
   60 Hz, skip moves under 2 pt, auto-pause for 1 s when real mouse movement is seen.
   `CGWarpMouseCursorPosition` as a fallback setting. Report `AXIsProcessTrusted`,
   `CGPreflightPostEventAccess`, `CGPreflightListenEventAccess` in status; prompt only when the
   user enables the cursor.
4. **Dwell click, opt-in**, after the cursor works; respect a rest zone.
5. **Hotkeys via `RegisterEventHotKey`** (`quickmachotkey`, no permission). Defaults: Ctrl+Cmd+Opt
   with **G** pause/resume, **C** recalibrate, **R** quick refine, **V** validate, **O** toggle
   overlay. Ctrl+Cmd+Opt plus a letter is unused by macOS defaults _(checked against my knowledge
   of the shortcut list, not on a Mac; VoiceOver users have VO+Cmd+letter commands while VoiceOver is on, so make these configurable)_ and passes the macOS 15 modifier rule. Do not use pynput
   listeners.
6. **Screen info** from `CGGetActiveDisplayList`, `CGDisplayBounds`, `CGDisplayScreenSize` with
   the sanity check above.
7. Skip virtual HID, HID page 0x12 and Head Pointer integration.
