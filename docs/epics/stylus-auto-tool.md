# EPIC: Auto-activate a tool on stylus movement

Status: Implemented (pending real-stylus hardware verification)
Owner (architect): Claude (supervising)
Platform scope for v1: **Windows** (macOS/Linux: pluggable no-op backend, wired for later)

## Detection method change: WH_MOUSE_LL → Raw Input (digitizer)
The original Windows backend used a `WH_MOUSE_LL` hook + the `dwExtraInfo` pen
signature. **This does not work for graphics tablets (XPPen/Huion) and similar
pen digitizers:** their pen input flows through the Windows pointer/Ink pipeline
(HID usage page `0x0D`) and is never promoted to the legacy mouse-message queue
the hook taps — so the hook sees *nothing* for the pen (confirmed on an XPPen:
mouse events logged, stylus events did not). Toggling the tablet's "Windows Ink"
off doesn't help either — it then emits unsigned mouse events, indistinguishable
from a real mouse.

The backend now uses **Raw Input (`WM_INPUT`)**: a hidden message-only window
registers for the pen digitizer (usage page `0x0D`, usage `0x02`) and the mouse
(usage page `0x01`, usage `0x02`) with `RIDEV_INPUTSINK`, and classifies each
event by `RAWINPUTHEADER.dwType` (`RIM_TYPEHID` → pen, `RIM_TYPEMOUSE` → mouse).
This classifies by *device*, not by a promoted-mouse signature, so it sees the
pen directly regardless of the Windows Ink setting, and covers XPPen/Huion/
Wacom/Surface uniformly. The `createStylusWatcher` contract and everything
downstream (coordinator, IPC, settings, packaging) are unchanged.

Confirmed on the dev machine: Windows reports the XPPen as a HID digitizer
(`VID_28BD` / "PenTablet", usage page `0x0D` usage `0x02`); `SM_DIGITIZER` has
`NID_EXTERNAL_PEN | NID_READY`. FFI smoke test passed (class registration,
message-only window, `RegisterRawInputDevices` success). Registering *Pen*
(usage `0x02`) rather than touch means finger touch is naturally excluded, so the
old signature-mask touch concern no longer applies.

Limitation (v1): tip-contact state isn't decoded from the raw header, so
`onPenActivity` reports `contact:false`; continuous pen reports keep the auto
session alive via the backend hysteresis (pen activity cancels a pending mouse
revert), which covers normal drawing. Decoding contact/pressure would require
parsing the HID report (`HidP_*`) — deferred.

## Post-implementation notes (architect)
- **Signature mask corrected to `0xFFFFFF00`** (the doc originally said `0xFFFFFF80`). With `0xFFFFFF80` the touch bit folds into the test and touch events misclassify as *mouse*, which on pen+touch devices (Surface/2-in-1 — our exact target users) would make a finger/palm touch spuriously revert out of stylus mode. `0xFFFFFF00` classifies touch as touch, which is then ignored (neither pen nor mouse).
- **koffi packaging:** koffi 3.x ships its native `.node` in a *separate* platform package `@koromix/koffi-<platform>-<arch>`, not inside `koffi`. Both `koffi` and `@koromix` must be copied into the packaged app and asar-unpacked (see `tools/forge/forge.config.js` `packageAfterCopy` + `asar.unpack`). A Node-only smoke test does not catch this — it only surfaces in a built installer.
- **Verified:** webpack build of all entries; koffi externalized (not bundled); `koffi.node` present + unpacked in the packaged app; koffi FFI executes under the Electron 40 runtime ABI. **Not yet verified (needs hardware):** live WH_MOUSE_LL pen/mouse classification and the end-to-end mode-switch UX.

## 1. Goal & user story

> As a presenter who uses a stylus/tablet, I want DrawPen to switch itself into draw mode with my preferred tool the instant I move the stylus near the screen, and switch back the instant I use the mouse — so I never touch a shortcut or the toolbar.

A new setting **"Tool on stylus movement"** (`None` + tool list). When set to a tool:

- Moving/hovering the **stylus** while in pointer mode → DrawPen enters draw mode and activates that tool. The first stroke draws (we activate on hover, before contact).
- Moving the **mouse** again → DrawPen reverts to pointer mode.
- `None` (default) → feature fully off, **no OS hook installed**.

## 2. Why this is mostly wiring + one hard part

The renderer already classifies `event.pointerType === 'pen'` (`DrawDesk.js`). Mode switching is centralized in `src/main/index.js` (`enableDrawMode`/`enablePointerMode`/`drawingMode`). Settings follow a known 3-spot pattern (schema + handler + UI).

**The one hard part:** in pointer mode the overlay window is *hidden*, so no renderer can hear the stylus. Detection must happen at the OS level, in the **main process**.

### Windows detection method (committed)

Windows stamps a signature on mouse messages synthesized from a pen/touch digitizer. In a low-level mouse hook (`SetWindowsHookEx(WH_MOUSE_LL)`), `MSLLHOOKSTRUCT.dwExtraInfo` carries it:

```
isPenOrTouch = (dwExtraInfo & 0xFFFFFF80) === 0xFF515700
isTouch      = isPenOrTouch && (dwExtraInfo & 0x80)
isPen        = isPenOrTouch && !(dwExtraInfo & 0x80)
isMouse      = !isPenOrTouch
```

A hovering pen drives the system cursor and emits `WM_MOUSEMOVE` carrying this signature **even with no DrawPen window focused or visible** — exactly what we need. Plain mouse moves lack it.

We install the hook via **`koffi`** (FFI) — **no native compile / node-gyp / @electron/rebuild / extra code-signing**. The WH_MOUSE_LL callback is dispatched on the thread that set the hook; Electron's main thread already pumps the Win32 message loop, so a koffi-registered JS callback fires there. The callback must be cheap: classify, update flags, defer any Electron work with `setImmediate`, then `CallNextHookEx` and return immediately.

> Fallback (documented, not built): an always-present click-through overlay using `setIgnoreMouseEvents(true,{forward:true})` reading `pointerType` in the renderer. Rejected for v1 because it's unverified that forwarded moves preserve pen type / hover, and it would rework the hide/show model. The koffi hook integrates with the *existing* hide/show model untouched.

## 3. Architecture

```
src/main/stylus/
  index.js                 createStylusWatcher() — platform selector + shared contract
  windowsStylusWatcher.js  koffi WH_MOUSE_LL backend (the real one)
  nullStylusWatcher.js     no-op backend for darwin/linux (isSupported:false)

src/main/index.js          coordinator/state-machine + schema key + IPC + lifecycle
src/renderer/app_page/preload.js       + onForceTool bridge
src/renderer/app_page/components/Application.js   force_tool handler (ref-based)
src/renderer/settings_page/preload.js  + setStylusTool, platform flag
src/renderer/settings_page/components/Settings.js   new "Stylus" section
src/renderer/app_page/components/constants.js       STYLUS_TOOL_OPTIONS
```

### 3.1 Detector contract (the interface every backend implements)

```js
// createStylusWatcher(handlers) -> watcher
//   handlers.onPenActivity({ contact: boolean })   // pen hover/move/down (digitizer-signed)
//   handlers.onMouseActivity()                      // genuine mouse move (un-signed)
// watcher.isSupported : boolean                     // false on platforms with no backend yet
// watcher.start() : void                            // installs hook (idempotent)
// watcher.stop()  : void                            // uninstalls hook (idempotent)
```

Backends own debounce/throttle of the *raw* stream so handlers fire at sane rates (target: pen ≤ ~60/s, mouse emitted only after small hysteresis — see §3.4). `index.js` selects `windowsStylusWatcher` on `win32`, else `nullStylusWatcher`. **No `koffi` import may execute on non-Windows** (lazy `require` inside the win32 branch) so mac/Linux never load it.

### 3.2 Coordinator state machine (in `src/main/index.js`)

New state:
- `autoStylusActive` (bool) — true only while a *stylus-initiated* draw session is live.
- `penContact` (bool) — pen tip currently down (from `onPenActivity.contact`).
- `manualSuppressUntil` (ts) — set when user manually toggles; auto ignores pen until then.
- `stylusRevertTimer` — pending revert-to-pointer timeout.
- `stylusWatcher` — the watcher instance (or null).

`enableDrawMode(...)` gains an optional `{ auto = false }`; it sets `autoStylusActive = auto`. All existing callers keep default `false` (so a manual draw session is never reverted by a mouse move). `enablePointerMode()` always sets `autoStylusActive = false` (any pointer-mode entry ends an auto session).

Events:

- **onPenActivity({contact})**: `penContact = contact`. Clear `stylusRevertTimer`. Ignore if `stylus_tool === 'none'` or `now < manualSuppressUntil`. If currently pointer mode → `enableDrawMode({auto:true})` then `mainWindow.webContents.send('force_tool', stylus_tool)`. If already in an auto session → keep alive (no-op).
- **onMouseActivity()**: ignore unless `autoStylusActive`. Ignore while `penContact`. (Re)arm `stylusRevertTimer(STYLUS_REVERT_GRACE_MS)`; on fire, if still `autoStylusActive && !penContact` → `enablePointerMode()`.

Manual-override: `toggleDrawOrPointerMode()` (the user-driven path: global shortcut, tray click, renderer pointer toggle) sets `manualSuppressUntil = now + STYLUS_MANUAL_SUPPRESS_MS`.

Lifecycle:
- `reconfigureStylusWatcher()` — called on boot (after windows exist) and whenever `stylus_tool` changes. If `isWin && stylus_tool !== 'none'`: lazily create + `start()`. Else `stop()` + drop. Guard `!watcher.isSupported`.
- `app.on('will-quit')` / window-closed cleanup → `stylusWatcher?.stop()`.

### 3.3 Settings + IPC

- **schema**: add `stylus_tool: { type:'string', default:'none' }`.
- **`get_configuration`**: add `stylus_tool: store.get('stylus_tool')`.
- **`set_stylus_tool` handler**: `store.set('stylus_tool', value)`; `reconfigureStylusWatcher()`; return null.
- **app preload**: add `onForceTool: (cb) => ipcRenderer.on('force_tool', cb)`.
- **settings preload**: add `setStylusTool: (v) => ipcRenderer.invoke('set_stylus_tool', v)` and expose `platform` (or `isWin`).
- **Application.js**: register `onForceTool` once in the existing `useEffect([],…)`, but route through a **ref** to avoid the stale-closure bug (the once-registered listener must call the *latest* `handleChangeTool`, not the one captured at mount). Pattern: keep `handleChangeToolRef.current = handleChangeTool` updated each render; listener calls `handleChangeToolRef.current(tool)`.

### 3.4 Tuning constants (named, in the win backend / coordinator)

| Const | Default | Purpose |
|---|---|---|
| `STYLUS_REVERT_GRACE_MS` | `1200` | mouse-move → revert delay; cancelled by any pen activity (combines grace + hysteresis). |
| `STYLUS_MANUAL_SUPPRESS_MS` | `1500` | after a manual toggle, ignore stylus auto-activation. |
| `MOUSE_HYSTERESIS_MS` | `120` | backend: min sustained mouse movement before emitting `onMouseActivity`. |
| `PEN_THROTTLE_MS` | `16` | backend: throttle pen events to ~60/s. |

Tune during review; expose as named constants, not magic numbers.

## 4. Tool option list (`STYLUS_TOOL_OPTIONS` in `constants.js`)

Offer only tools that are useful as an auto-activated drawing tool. **Exclude `text`** (needs click+type) and `eraser`.

```
[ {value:'none',        label:'None'},
  {value:'pen',         label:'Pen'},
  {value:'fadepen',     label:'Fading Pen'},
  {value:'highlighter', label:'Highlighter'},
  {value:'laser',       label:'Laser'},
  {value:'arrow',       label:'Arrow'},
  {value:'flat_arrow',  label:'Flat Arrow'},
  {value:'rectangle',   label:'Rectangle'},
  {value:'oval',        label:'Oval'},
  {value:'line',        label:'Line'} ]
```

`set_stylus_tool` must validate against this allow-list (reject unknown → coerce to `none`).

## 5. UX / robustness requirements (acceptance-relevant)

1. **No mid-stroke revert** — never revert while `penContact`.
2. **Grace after pen-up** — multi-stroke drawing not interrupted (`STYLUS_REVERT_GRACE_MS`).
3. **Respect manual control** — manual toggles win and suppress auto briefly; mouse never reverts a *manually* started draw session (`autoStylusActive` gate).
4. **Activate on the pen's monitor** — reuse existing `getUnderCursorMonitor()` (cursor == pen position); no extra work.
5. **Zero cost when off** — `none` installs no hook; non-Windows never loads `koffi`.
6. **Cheap hook callback** — classify + defer; never block the message loop.
7. **Feedback (optional, nice-to-have)** — brief `Toast` "Stylus mode" on auto-activate; do not implement if it risks scope. Mark clearly if skipped.

## 6. Work packages

WP1–WP4 touch **disjoint files** and can run in parallel against the contracts above.

- **WP1 — Detector module** (`src/main/stylus/**`, `package.json`). koffi backend + null backend + selector. Add `koffi` dep. Self-test with a debug log gated on `isDevelopment`. Owns only new files + the dependency add.
- **WP2 — Main integration** (`src/main/index.js` only). Schema key, `get_configuration`, `set_stylus_tool`, coordinator state machine (§3.2), `enableDrawMode({auto})`, `force_tool` send, `reconfigureStylusWatcher`, lifecycle cleanup, suppress-on-manual-toggle. `require`s WP1 by documented path/API.
- **WP3 — Renderer force-tool** (`app_page/preload.js`, `Application.js`). `onForceTool` bridge + ref-routed handler (§3.3).
- **WP4 — Settings UI** (`settings_page/preload.js`, `Settings.js`, `app_page/components/constants.js`). New "Stylus" sidebar section with the `<select>`; `STYLUS_TOOL_OPTIONS`; Windows-only gating + helper note on other platforms.
- **WP5 — Docs/changelog (architect)** — `CHANGELOG.md`, `CLAUDE.md` (note `src/main/stylus/`), this doc's status.

### Integration contract (shared names — do not rename)
- IPC: `set_stylus_tool` (invoke), `force_tool` (send).
- Store key: `stylus_tool`. Values: see §4 allow-list; default `'none'`.
- Detector module: `require('./stylus')` → `createStylusWatcher({onPenActivity,onMouseActivity})`.

## 7. Out of scope (v1)
- macOS (`NSEvent` global monitor) / Linux (XInput2) backends — interface is ready; backends are future work.
- Per-tool stylus color/width overrides.
- Persisting the forced tool as the user's default tool (it's a transient override).

## 8. Verification
- `none`: no hook (add a dev log on hook install/uninstall to confirm).
- Build passes (`npm start` boots; `npm run package_no_sign` packs with `koffi`).
- Manual on Windows w/ stylus: hover → draw mode + tool; draw multi-stroke uninterrupted; mouse → reverts after grace; global-shortcut toggle still authoritative.
- Non-Windows: app boots, setting shows as unsupported, `koffi` never loaded.
