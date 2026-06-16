# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DrawPen is a cross-platform (macOS / Windows / Linux) screen annotation tool built with Electron + React. It overlays a transparent, click-through-when-idle, always-on-top window across the active monitor so the user can draw on top of anything on screen. There is no test suite and no linter configured — verification is manual by running the app.

## Commands

- `npm install` — install dependencies (Node `>=22 <23` is required; see `engines`).
- `npm start` — build, launch with HMR, and watch (`electron-forge start`). The script sets `NODE_ENV=development` using POSIX syntax; on Windows run it from a Bash-compatible shell (Git Bash) or set the env var first in PowerShell (`$env:NODE_ENV='development'; electron-forge start`).
- `npm run package` — produce an unpacked app in `out/` (`--no-sign` variant: `npm run package_no_sign`).
- `npm run make` — build platform installers (dmg / squirrel / deb / rpm / zip).
- `npm run publish` — build and publish a draft GitHub release.

In development mode several behaviors change (see `src/main/index.js`): the main window shrinks to 500×500 and becomes resizable, DevTools are enabled on every window, and `rawLog` console output is active (it is a no-op in production). Telemetry (`launchTracker`, PostHog) is skipped in development.

## Architecture

Electron two-process design. The **main process** is a single file, `src/main/index.js`; the **renderer** is four independent webpack entry points under `src/renderer/`, each its own mini React/HTML app with its own `preload.js`.

### Processes and windows

The main process owns all OS integration: the tray icon and context menu, global shortcuts, multi-monitor placement, persisted settings, screenshot capture, and login-item/auto-update wiring. It creates four `BrowserWindow`s, wired in `tools/forge/forge.config.js` (`entryPoints`) and reachable in main via the generated `*_WEBPACK_ENTRY` / `*_PRELOAD_WEBPACK_ENTRY` globals:

- **app_window** — the full-screen transparent drawing overlay (the main React app, `app_page/`).
- **extended_toolbar_window** — a small always-present floating toolbar shown in *pointer mode* (`extended_toolbar_page/`).
- **about_window**, **settings_window** — ordinary utility dialogs (`about_page/`, `settings_page/`).

### Draw mode vs. pointer mode

The central UX state is `drawingMode` in main. Toggling (global shortcut, tray click, or IPC from a renderer) swaps which window is visible: draw mode shows the full overlay (`app_window`); pointer mode hides it and shows only the floating `extended_toolbar_window`, returning OS focus to the app underneath (`releaseFocusBack`). Most `enableDrawMode`/`enablePointerMode`/`hideApp` transitions also call `updateContextMenu` so tray labels stay in sync.

### State persistence

`electron-store` with a strict `schema` declared at the top of `src/main/index.js` is the single source of truth for all persisted settings (toolbar position, active tool/color/width, whiteboard config, keybindings, fade timings, monitor selection, etc.). The renderer never touches the store directly — it reads via the `get_settings` / `get_configuration` IPC handlers and writes via the per-setting `set_*` handlers. When you add a setting, you must update it in **three** places: the `schema`, the relevant getter handler(s), and a `set_*` handler. Settings that affect live drawing are pushed back to the overlay via `refreshSettingsInRenderer` (a `refresh_settings` message); some changes instead call `mainWindow.reload()`.

### IPC contract

All cross-process communication goes through `contextBridge` in each page's `preload.js` (e.g. `app_page/preload.js` exposes `window.electronAPI`). `nodeIntegration` is off everywhere; the preload allow-list is the only surface. Renderer→Main calls are `ipcRenderer.invoke` (handled by `ipcMain.handle`); Main→Renderer pushes are `webContents.send` + `ipcRenderer.on`. To add an interaction, extend the preload bridge and add the matching handler/sender in main — don't reach for `ipcRenderer` directly in React code.

### Stylus auto-tool (Windows)

`src/main/stylus/` is a platform-abstracted watcher that detects stylus vs. mouse input at the OS level so DrawPen can auto-enter draw mode when a pen moves (setting: `stylus_tool`, default `none`). `index.js` selects a backend; `windowsStylusWatcher.js` installs a low-level mouse hook (`WH_MOUSE_LL`) via the **`koffi`** FFI library and classifies events by the Windows digitizer signature in `dwExtraInfo` (`(extra & 0xFFFFFF00) === 0xFF515700`; bit `0x80` = touch). `nullStylusWatcher.js` is the no-op backend for macOS/Linux — the interface is ready for future native backends. The coordinator/state-machine lives in `src/main/index.js` (`onPenActivity`/`onMouseActivity`/`reconfigureStylusWatcher`, plus `autoStylusActive`/`penContact`/`manualSuppressUntil` state); pen detection triggers `enableDrawMode({ auto: true })` + a `force_tool` IPC to the overlay.

**Packaging note:** `koffi` is a native addon. It is externalized from the webpack bundle (`tools/webpack/main.js` `externals`) and copied into the packaged app by a `packageAfterCopy` hook in `tools/forge/forge.config.js` — which must copy **both** `node_modules/koffi` **and** `node_modules/@koromix` (koffi 3.x ships its prebuilt `.node` in a separate `@koromix/koffi-<platform>-<arch>` package), with both asar-unpacked. The hook never loads `koffi` off-Windows (lazy `require` inside the win32 branch of `stylus/index.js`).

### Multi-monitor

Monitor resolution flows through a fallback chain used consistently across placement functions: `getLockedMonitor()` (user-pinned "fixed" display) → `getActiveMonitor()` (last-used) → cursor/toolbar-based fallback. `active_monitor_id` caches the last overlay display; `display-added/removed/metrics-changed` events clear it and hide the app. Accelerators are stored canonically with `CmdOrCtrl` and translated for the UI via `normalizeAcceleratorForUI` / `deNormalizeAcceleratorFromUI`.

### The drawing canvas (app_page)

`app_page/components/Application.js` is the large stateful root: it holds all figure arrays and mouse-interaction logic, and renders `DrawDesk`, `ToolBar`, `Whiteboard`, `TextEditor`, `CuteCursor`, `RippleEffect`, and `Toast`. Figures are categorized into separate collections — permanent figures, fade figures (auto-disappearing pen strokes), laser figures (time-limited), and eraser figures — each with its own lifecycle.

`components/DrawDesk.js` renders everything to a `<canvas>` using a device-pixel-ratio scale and an offscreen canvas; the actual per-shape rendering lives in `components/drawer/figures.js` (one `drawX` / `drawXActive` function per shape). Hit-testing, dragging, resizing, and selection-handle math are in `utils/figureDetection.js`; geometry helpers (point filtering, snapping, aspect-ratio lock, canvas text measurement) are in `utils/general.js`.

Tool/color/width definitions and all tunable magic numbers (timings, sizes, the `colorList` and `widthList` tables, palm-rejection thresholds) are centralized in `app_page/components/constants.js`. Pen strokes use `perfect-freehand`; the magic-brush smoothing uses `lazy-brush`. Index 0 of `colorList` (`color_rainbow`) is special-cased into rainbow rendering rather than a fixed color.

## Conventions

- Plain JavaScript + JSX (Babel `@babel/preset-react`), no TypeScript. React 18 function components with hooks; no Redux — state lives in the `Application` component and `electron-store`.
- Each component is paired with a sibling `.scss` of the same name, imported at the top of the file.
- Platform branches use the `isMac` / `isWin` / `isLinux` constants in main; Linux frequently needs its own path (no login items, tray accelerator quirks, X11/Wayland workaround documented in `README.md`).
- `assets/` is build/runtime image assets; `src/assets/` is copied into the renderer bundle by `CopyWebpackPlugin`. Forge config and webpack configs live under `tools/`.
