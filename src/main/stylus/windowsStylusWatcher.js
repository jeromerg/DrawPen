// Windows stylus watcher: Raw Input (WM_INPUT) from the HID digitizer.
//
// Why not WH_MOUSE_LL? Graphics tablets (XPPen/Huion) and many pen digitizers
// deliver pen input through the Windows pointer/Ink pipeline (HID usage page
// 0x0D), which is NOT promoted to the legacy mouse-message queue that a
// low-level mouse hook taps — so the hook sees nothing for those pens. Raw Input
// classifies by *device*, not by a promoted-mouse signature, so it sees the pen
// directly regardless of the tablet's "Windows Ink" setting.
//
// Design: a hidden message-only window receives WM_INPUT for two registered
// device classes — the pen digitizer (usage page 0x0D, usage 0x02) and the
// mouse (usage page 0x01, usage 0x02), both with RIDEV_INPUTSINK so input
// arrives even when DrawPen has no focus/visible window. The window's WndProc
// (a koffi-registered callback) classifies each WM_INPUT by the RAWINPUTHEADER
// device type: RIM_TYPEHID -> pen, RIM_TYPEMOUSE -> mouse. Electron's main
// thread already pumps the Win32 message loop, so the WndProc fires there.
//
// koffi is a CommonJS native module; this file is only ever required on win32
// (see ./index.js), so loading koffi here is safe.
import koffi from 'koffi';

const isDevelopment = process.env.NODE_ENV === 'development';

// ---- Tuning constants --------------------------------------------------------
const PEN_THROTTLE_MS = 16; // throttle pen events to ~60/s
const MOUSE_HYSTERESIS_MS = 120; // min sustained mouse movement before emitting onMouseActivity

// ---- Win32 constants ---------------------------------------------------------
const WM_INPUT = 0x00ff;

const RID_HEADER = 0x10000005; // GetRawInputData: fetch only the RAWINPUTHEADER
const RAWINPUTHEADER_SIZE = 24; // x64: DWORD dwType; DWORD dwSize; HANDLE hDevice; WPARAM wParam;
const RAWINPUTDEVICE_SIZE = 16; // USHORT usUsagePage; USHORT usUsage; DWORD dwFlags; HWND hwndTarget;

const RIM_TYPEMOUSE = 0;
const RIM_TYPEHID = 2;

const RIDEV_REMOVE = 0x00000001;
const RIDEV_INPUTSINK = 0x00000100;

// HID usage pages / usages we care about.
const HID_USAGE_PAGE_GENERIC = 0x01;
const HID_USAGE_GENERIC_MOUSE = 0x02;
const HID_USAGE_PAGE_DIGITIZER = 0x0d;
const HID_USAGE_DIGITIZER_PEN = 0x02;

// Message-only window parent: (HWND)-3, as an unsigned pointer-sized value.
const HWND_MESSAGE = 0xfffffffffffffffdn;

const CLASS_NAME = 'DrawPenStylusRawInputWnd';

function log(...args) {
  if (isDevelopment) {
    console.log('[DRAWPEN:STYLUS]', ...args);
  }
}

export function createWindowsStylusWatcher(handlers = {}) {
  const onPenActivity = typeof handlers.onPenActivity === 'function' ? handlers.onPenActivity : () => {};
  const onMouseActivity = typeof handlers.onMouseActivity === 'function' ? handlers.onMouseActivity : () => {};

  // FFI state (resolved once; reused across start/stop cycles).
  let user32 = null;
  let kernel32 = null;
  let RegisterClassExW = null;
  let UnregisterClassW = null;
  let CreateWindowExW = null;
  let DestroyWindow = null;
  let DefWindowProcW = null;
  let RegisterRawInputDevices = null;
  let GetRawInputData = null;
  let GetModuleHandleW = null;
  let WndProcPtr = null; // koffi pointer type for the WndProc prototype
  let WNDCLASSEXW = null; // koffi struct type

  // Runtime state.
  let supported = false;
  let initFailed = false;
  let hInstance = 0n;
  let classAtom = 0; // 0 = not registered
  let hwnd = 0n; // 0 = no window
  let registeredCallback = null; // koffi-registered WndProc (MUST stay referenced)
  let rawInputRegistered = false;

  // Reusable scratch buffers for the WndProc (avoid per-event allocation).
  let headerBuf = null;
  let headerSizeBuf = null;

  // Classification / debounce state.
  let lastPenEmit = 0;
  let mousePendingTimer = null;
  let lastPenActivityTime = 0;

  function loadFFI() {
    if (RegisterClassExW) return true; // already loaded
    if (initFailed) return false;

    try {
      user32 = koffi.load('user32.dll');
      kernel32 = koffi.load('kernel32.dll');

      // LRESULT CALLBACK WndProc(HWND, UINT, WPARAM, LPARAM)
      const WndProcProto = koffi.proto('__stdcall WndProcProto', 'intptr_t', [
        'uintptr_t', // hwnd
        'uint32', // msg
        'uintptr_t', // wParam
        'intptr_t', // lParam (HRAWINPUT for WM_INPUT)
      ]);
      WndProcPtr = koffi.pointer(WndProcProto);

      // typedef struct { UINT cbSize; UINT style; WNDPROC lpfnWndProc;
      //   int cbClsExtra; int cbWndExtra; HINSTANCE hInstance; HICON hIcon;
      //   HCURSOR hCursor; HBRUSH hbrBackground; LPCWSTR lpszMenuName;
      //   LPCWSTR lpszClassName; HICON hIconSm; } WNDCLASSEXW;
      WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
        cbSize: 'uint32',
        style: 'uint32',
        lpfnWndProc: WndProcPtr,
        cbClsExtra: 'int',
        cbWndExtra: 'int',
        hInstance: 'uintptr_t',
        hIcon: 'uintptr_t',
        hCursor: 'uintptr_t',
        hbrBackground: 'uintptr_t',
        lpszMenuName: 'str16',
        lpszClassName: 'str16',
        hIconSm: 'uintptr_t',
      });

      RegisterClassExW = user32.func('uint16 __stdcall RegisterClassExW(WNDCLASSEXW *)');
      UnregisterClassW = user32.func('int __stdcall UnregisterClassW(str16, uintptr_t)');
      CreateWindowExW = user32.func(
        'uintptr_t __stdcall CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, uintptr_t, uintptr_t, uintptr_t, uintptr_t)'
      );
      DestroyWindow = user32.func('int __stdcall DestroyWindow(uintptr_t)');
      DefWindowProcW = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t, uint32, uintptr_t, intptr_t)');
      RegisterRawInputDevices = user32.func('int __stdcall RegisterRawInputDevices(void *, uint32, uint32)');
      GetRawInputData = user32.func('uint32 __stdcall GetRawInputData(intptr_t, uint32, void *, uint32 *, uint32)');
      GetModuleHandleW = kernel32.func('uintptr_t __stdcall GetModuleHandleW(uintptr_t)');

      headerBuf = Buffer.alloc(RAWINPUTHEADER_SIZE);
      headerSizeBuf = Buffer.alloc(4);

      supported = true;
      return true;
    } catch (err) {
      initFailed = true;
      supported = false;
      log('Failed to load FFI / Win32 symbols; stylus watcher disabled:', err && err.message);
      return false;
    }
  }

  // Emit a pen-activity event, throttled to ~60/s. Any pen activity cancels a
  // pending mouse emit (the user is using the pen, not the mouse).
  function emitPen() {
    const now = Date.now();
    lastPenActivityTime = now;

    if (mousePendingTimer) {
      clearTimeout(mousePendingTimer);
      mousePendingTimer = null;
    }

    if (now - lastPenEmit < PEN_THROTTLE_MS) return;
    lastPenEmit = now;

    // Defer off the WndProc so we never block the message loop. We cannot detect
    // tip contact cheaply from the header alone, so contact is reported false;
    // continuous pen reports keep the session alive via the hysteresis above.
    setImmediate(() => {
      try {
        onPenActivity({ contact: false });
      } catch (err) {
        log('onPenActivity handler threw:', err && err.message);
      }
    });
  }

  // Arm a hysteresis timer on mouse input. Only emit onMouseActivity if no pen
  // activity intervened during the window (the user is genuinely on the mouse).
  function noteMouseMove() {
    if (mousePendingTimer) return;
    const armedAt = Date.now();
    mousePendingTimer = setTimeout(() => {
      mousePendingTimer = null;
      if (lastPenActivityTime >= armedAt) return; // pen won — suppress
      try {
        onMouseActivity();
      } catch (err) {
        log('onMouseActivity handler threw:', err && err.message);
      }
    }, MOUSE_HYSTERESIS_MS);
  }

  // The window procedure. Kept cheap; always ends in DefWindowProcW.
  function wndProc(hWnd, msg, wParam, lParam) {
    try {
      if (msg === WM_INPUT) {
        headerSizeBuf.writeUInt32LE(RAWINPUTHEADER_SIZE, 0);
        const res = GetRawInputData(lParam, RID_HEADER, headerBuf, headerSizeBuf, RAWINPUTHEADER_SIZE);

        if (res !== 0xffffffff && res > 0) {
          const dwType = headerBuf.readUInt32LE(0);

          if (dwType === RIM_TYPEHID) {
            // From our digitizer (usage page 0x0D, usage 0x02 = pen) registration.
            emitPen();
          } else if (dwType === RIM_TYPEMOUSE) {
            noteMouseMove();
          }
        }
      }
    } catch (err) {
      log('wndProc threw (continuing):', err && err.message);
    }
    return DefWindowProcW(hWnd, msg, wParam, lParam);
  }

  // Build the 2-entry RAWINPUTDEVICE array (pen + mouse) targeting our window.
  function buildRawInputDevices(targetHwnd, flags) {
    // koffi returns HWND as a Number when it fits in a safe integer; writeBigUInt64LE
    // requires a BigInt, so coerce.
    const target = BigInt(targetHwnd);
    const buf = Buffer.alloc(RAWINPUTDEVICE_SIZE * 2);
    // [0] pen digitizer
    buf.writeUInt16LE(HID_USAGE_PAGE_DIGITIZER, 0);
    buf.writeUInt16LE(HID_USAGE_DIGITIZER_PEN, 2);
    buf.writeUInt32LE(flags, 4);
    buf.writeBigUInt64LE(target, 8);
    // [1] mouse
    buf.writeUInt16LE(HID_USAGE_PAGE_GENERIC, 16);
    buf.writeUInt16LE(HID_USAGE_GENERIC_MOUSE, 18);
    buf.writeUInt32LE(flags, 20);
    buf.writeBigUInt64LE(target, 24);
    return buf;
  }

  function start() {
    if (hwnd) return; // idempotent: already running
    if (!loadFFI()) return; // FFI unavailable -> no-op (app still boots)

    try {
      hInstance = GetModuleHandleW(0n);

      // Register the window class (once; reused across start/stop if atom kept).
      if (!classAtom) {
        registeredCallback = koffi.register(wndProc, WndProcPtr);
        const wndClass = {
          cbSize: koffi.sizeof(WNDCLASSEXW),
          style: 0,
          lpfnWndProc: registeredCallback,
          cbClsExtra: 0,
          cbWndExtra: 0,
          hInstance,
          hIcon: 0n,
          hCursor: 0n,
          hbrBackground: 0n,
          lpszMenuName: null,
          lpszClassName: CLASS_NAME,
          hIconSm: 0n,
        };
        classAtom = RegisterClassExW(wndClass);
        if (!classAtom) {
          log('RegisterClassExW failed; stylus watcher disabled');
          cleanupCallback();
          return;
        }
      }

      // Message-only window (HWND_MESSAGE parent).
      hwnd = CreateWindowExW(0, CLASS_NAME, null, 0, 0, 0, 0, 0, HWND_MESSAGE, 0n, hInstance, 0n);
      if (!hwnd) {
        log('CreateWindowExW failed; stylus watcher disabled');
        return;
      }

      const devices = buildRawInputDevices(hwnd, RIDEV_INPUTSINK);
      const ok = RegisterRawInputDevices(devices, 2, RAWINPUTDEVICE_SIZE);
      if (!ok) {
        log('RegisterRawInputDevices failed; stylus watcher disabled');
        stop();
        return;
      }
      rawInputRegistered = true;

      log('Raw Input watcher started (digitizer pen + mouse, INPUTSINK)');
    } catch (err) {
      log('Failed to start Raw Input watcher; stylus watcher disabled:', err && err.message);
      stop();
    }
  }

  function cleanupCallback() {
    if (registeredCallback) {
      try {
        koffi.unregister(registeredCallback);
      } catch (_) {
        /* ignore */
      }
      registeredCallback = null;
    }
  }

  function stop() {
    if (mousePendingTimer) {
      clearTimeout(mousePendingTimer);
      mousePendingTimer = null;
    }

    try {
      if (rawInputRegistered && hwnd) {
        // Unregister raw input (hwndTarget must be NULL when removing).
        const devices = buildRawInputDevices(0n, RIDEV_REMOVE);
        RegisterRawInputDevices(devices, 2, RAWINPUTDEVICE_SIZE);
      }
    } catch (err) {
      log('Unregister raw input threw:', err && err.message);
    }
    rawInputRegistered = false;

    try {
      if (hwnd) DestroyWindow(hwnd);
    } catch (err) {
      log('DestroyWindow threw:', err && err.message);
    }
    hwnd = 0n;

    try {
      if (classAtom) {
        UnregisterClassW(CLASS_NAME, hInstance);
        classAtom = 0;
      }
    } catch (err) {
      log('UnregisterClassW threw:', err && err.message);
    }

    // Drop the WndProc callback only after the class/window are gone.
    cleanupCallback();

    log('Raw Input watcher stopped');
  }

  // Probe FFI availability up front so `isSupported` is meaningful before start().
  loadFFI();

  return {
    get isSupported() {
      return supported;
    },
    start,
    stop,
  };
}

export default createWindowsStylusWatcher;
