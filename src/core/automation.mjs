/**
 * Driving a graphical application the way a person does: look at the screen, decide where to
 * act, move the real pointer, and confirm the result by looking again.
 *
 * This exists because Windows message-based automation (`PostMessage`) only reaches controls
 * that read their input from a window message queue. Applications that draw their own interface
 * — browsers, CAD viewports, games, anything on a canvas — read raw device state instead, so the
 * only universal route is genuine system input. Everything here therefore acts on the real
 * desktop.
 *
 * That has two consequences the caller must respect, and this module builds them in:
 *
 *   1. Real input occupies the machine. The user's pointer and keyboard are genuinely in use
 *      while an action runs, so an action must be aimed at a window that has been brought to the
 *      front and verified to be there.
 *   2. Failure is silent. Moving a pointer and clicking always "succeeds"; whether it clicked the
 *      right thing is a separate question. So every call returns what it observed, and
 *      {@link clickText} refuses to click when it cannot find its target rather than clicking
 *      whatever happens to be nearest.
 *
 * Held down by both: the PowerShell helper is the thing that touches the OS, and it is invoked
 * per action so each step is separately recorded and separately failable.
 *
 * @module video-factory/core/automation
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..', '..')

/** The PowerShell helpers that touch the OS. */
export const DESKTOP_SCRIPT = resolve(PLUGIN_ROOT, 'src', 'bin', 'desktop.ps1')
export const OCR_SCRIPT = resolve(PLUGIN_ROOT, 'src', 'bin', 'ocr.ps1')
export const DRIVER_SCRIPT = resolve(PLUGIN_ROOT, 'src', 'bin', 'interception-input.ps1')

/**
 * The virtual HID keyboard client, built from `components/vhfkey`.
 *
 * This is the transport that matters, and the only one that is a real device. It is a small console
 * program that opens the driver's device interface and submits HID input reports; Windows then delivers
 * them through the ordinary keyboard stack, exactly as it would a physical keyboard's. Nothing above the
 * HID layer can tell the difference, which is the point — a filter driver can be bypassed or ignored,
 * and a user-mode injection API can be filtered out, but a device in the HID stack is the input path.
 *
 * It is also the transport that took the most work to reach: see `components/vhfkey/driver/vhfkey.c` for
 * the four faults that had to be fixed before the driver would load at all.
 */
export const VIRTUAL_HID_CLIENT = resolve(PLUGIN_ROOT, 'components', 'vhfkey', 'out', 'vhfctl.exe')

/**
 * The input transports available.
 *
 * `sendinput`    injects at user level through the Win32 input API.
 * `driver`       sends through the Interception filter driver, which sits below that boundary. It is only
 *                reachable while that filter is installed, and on this machine it currently is not. When it
 *                was, its pointer path worked and its keyboard path accepted every keystroke and delivered
 *                none. The cause of that was never established: the attractively simple explanation, that the
 *                filter did not attach to the emulated PS/2 keyboard of this virtual machine, is supported by
 *                no source that could be found, so it is not repeated here as though it were known.
 * `virtualkbd`   submits HID reports to a virtual keyboard device created by our own driver. Verified by
 *                typing into Notepad and reading the document back, byte for byte.
 * `virtualmouse` does the same for the pointer, positioned absolutely. Verified by moving it and reading the
 *                position back: every requested position landed within a pixel.
 */
export const INPUT_TRANSPORTS = ['sendinput', 'driver', 'virtualkbd', 'virtualmouse']

/**
 * Which transport to use for each kind of input, in order of preference, and why.
 *
 *   mouse     virtualmouse first. It is a real HID device, so nothing above the HID layer can treat its input
 *             as synthetic, and its absolute positioning was measured at a pixel or better. The Interception
 *             filter follows, for a machine where the virtual device is absent, then SendInput, which always
 *             works.
 *
 *   keyboard  virtualkbd first, for the same reason. SendInput second, because it is dependable and needs no
 *             installation. The filter driver last: it is the least useful of the three here, and on this
 *             machine it is not installed at all.
 *
 * The honest history is worth keeping: an earlier conclusion that SendInput could not activate a browser
 * button was wrong, and the real fault was coordinate arithmetic. The transports are chosen for what they
 * are, not as a fix for a bug that was never theirs.
 */
export const TRANSPORT_PREFERENCE = {
  mouse: ['virtualmouse', 'driver', 'sendinput'],
  keyboard: ['virtualkbd', 'sendinput', 'driver'],
}

/**
 * The keyboard transports to try, excluding one already known to be inert.
 *
 * `virtualkbd` reports success for every keystroke whether or not anything arrives, so it cannot be allowed
 * to absorb a request on a machine where the HID stack is not acting on its reports: the caller would believe
 * the text had been typed. Once the pointer canary in {@link verifyVirtualHidInput} has come back negative,
 * the virtual keyboard is dropped from the list and the next transport is used instead.
 *
 * With no verdict yet the preference is returned unchanged, so nothing is skipped on a machine where the
 * devices do work.
 *
 * @param {string} [requested] - a transport the caller insisted on, if any.
 * @returns {string[]} transports in the order to try.
 */
function keyboardOrder(requested) {
  const known = virtualHidVerdict !== null && !virtualHidVerdict.works

  // Asked for by name and known to be inert: going ahead would report success for keystrokes that never
  // arrive, which is the exact failure this function exists to prevent. Say so instead.
  if (known && requested === 'virtualkbd') {
    throw new AutomationError(
      `虚拟键盘被显式指定，但已验证它不产生输入：${virtualHidVerdict.reason}`,
    )
  }

  const order = requested ? [requested] : TRANSPORT_PREFERENCE.keyboard
  return known ? order.filter((transport) => transport !== 'virtualkbd') : order
}

/**
 * Run one action through the Interception driver.
 * @param {string} action - `probe`, `move`, `click`, or `point`.
 * @param {object} [params] - `{ X, Y, Button, Count }`.
 * @returns {Promise<object>} the helper's JSON report.
 * @throws {AutomationError} when the driver is absent or the action fails.
 */
export async function driverInput(action, params = {}, options = {}) {
  if (!existsSync(DRIVER_SCRIPT)) {
    throw new AutomationError(`找不到驱动输入脚本：${DRIVER_SCRIPT}`)
  }
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DRIVER_SCRIPT, '-Action', action]
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    args.push(`-${key}`, String(value))
  }

  try {
    const { stdout } = await run('powershell.exe', args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30_000,
      windowsHide: true,
      encoding: 'buffer',
    })
    const text = decodePowerShell(stdout)
    if (text === '') throw new AutomationError(`驱动动作 ${action} 没有返回内容`)
    const parsed = JSON.parse(text)
    if (parsed.ok !== true) {
      throw new AutomationError(
        `驱动动作 ${action} 未成功：${parsed.reason ?? JSON.stringify(parsed)}` +
          (parsed.hint === undefined ? '' : `（${parsed.hint}）`),
      )
    }
    return parsed
  } catch (error) {
    if (error instanceof AutomationError) throw error
    // An empty stderr is not a detail: reporting "failed:" with nothing after it is the unhelpful signal this
    // module exists to avoid, so the process's own message and exit code are used when stderr says nothing.
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error?.stderr ?? '')
    const detail = stderr.trim() || String(error?.message ?? error).trim()
    const exit = typeof error?.code === 'number' ? ` (exit ${error.code})` : ''
    throw new AutomationError(`驱动动作 ${action} 失败${exit}：${detail.slice(0, 400)}`)
  }
}

/**
 * Is the driver transport usable right now?
 *
 * The driver is installed but only joins the input stack after a restart, so this is a question
 * about the running system rather than about whether the files are present. It doubles as a
 * capability probe for reporting.
 *
 * @returns {Promise<{available: boolean, detail: object|null, reason: string|null}>} availability.
 */
export async function driverAvailable() {
  try {
    const report = await driverInput('probe')
    return { available: true, detail: report, reason: null }
  } catch (error) {
    return { available: false, detail: null, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Send keyboard input through the virtual HID keyboard.
 *
 * The client waits for the driver to accept each report and exits non-zero if any is refused, so a zero
 * exit is a real acknowledgement rather than a request that was queued somewhere. The console window is
 * suppressed: a visible one takes the foreground from the target and the keystrokes then go to the wrong
 * window, which is exactly the trap that made an early verification appear to fail.
 *
 * @param {'type'|'key'|'combo'|'probe'} action - what to send.
 * @param {object} [params] - `{ text, key, modifier }`.
 * @returns {Promise<object>} `{ ok, action, text|key, exitCode }`.
 * @throws {AutomationError} when the client is missing or the device refuses the input.
 */
export async function virtualKeyboardInput(action, params = {}, options = {}) {
  if (!existsSync(VIRTUAL_HID_CLIENT)) {
    throw new AutomationError(
      `虚拟键盘客户端不存在：${VIRTUAL_HID_CLIENT}。` +
        '先运行 components/vhfkey/build.ps1 构建，再运行 install-run.ps1 安装驱动。',
    )
  }

  let args
  switch (action) {
    case 'probe':
      args = ['probe']
      break
    case 'type':
      if (typeof params.text !== 'string' || params.text.length === 0) {
        throw new AutomationError('type 需要非空的 text')
      }
      args = ['type', params.text]
      break
    case 'key':
      if (typeof params.key !== 'string' || params.key.length === 0) {
        throw new AutomationError('key 需要按键名，例如 ENTER 或 A')
      }
      args = ['key', params.key]
      break
    case 'combo':
      if (typeof params.modifier !== 'string' || typeof params.key !== 'string') {
        throw new AutomationError('combo 需要 modifier 与 key，例如 CTRL 与 A')
      }
      args = ['combo', params.modifier, params.key]
      break
    default:
      throw new AutomationError(`虚拟键盘不支持的动作：${action}`)
  }

  let stdout = ''
  let exitCode = 0
  try {
    const result = await run(VIRTUAL_HID_CLIENT, args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? 60_000,
      windowsHide: true,
      encoding: 'buffer',
    })
    stdout = result.stdout.toString('utf8').replace(/^\uFEFF/, '').trim()
  } catch (error) {
    exitCode = typeof error?.code === 'number' ? error.code : 1
    stdout = (error?.stdout ?? Buffer.alloc(0)).toString('utf8').trim()
    // Exit code 2 is the client's own "device not found", which is a different problem from a rejected
    // report and worth naming so a caller does not look in the wrong place.
    const hint = exitCode === 2 ? '（驱动未安装或设备未启动）' : ''
    throw new AutomationError(`虚拟键盘动作 ${action} 失败：${stdout || '(无输出)'}${hint}`)
  }

  return { ok: true, action, exitCode, detail: stdout || null }
}

/**
 * Can the virtual HID devices actually produce input?
 *
 * Opening a device and sending it a report is not the same as the system acting on that report. A device can
 * be present, started, correctly bound and accepting reports while something above the HID layer declines to
 * act on them — which is the state this machine was left in, and it made every call succeed and nothing
 * happen.
 *
 * The pointer can be checked and a keystroke cannot, but both come from the same driver and the same
 * framework, so the pointer is used as the canary: if it provably does not move, the keyboard's reports are
 * not being acted on either.
 *
 * The check moves the pointer a little and puts it back. That is a visible twitch, so it is only done when a
 * caller asks for it (`video_env probe`) and the verdict is remembered for the process. Nothing else calls it
 * as a side effect.
 *
 * @returns {Promise<{works: boolean, reason: string|null}>} the verdict.
 */
export async function verifyVirtualHidInput() {
  if (virtualHidVerdict !== null) {
    return virtualHidVerdict
  }

  try {
    const origin = await desktop('cursor')
    if (typeof origin?.x !== 'number' || typeof origin?.y !== 'number') {
      virtualHidVerdict = { works: false, reason: 'could not read the pointer position' }
      return virtualHidVerdict
    }

    // A displacement large enough to be unambiguous, but small enough to be a twitch.
    const screen = await desktop('screen').catch(() => null)
    const extentX = screen?.virtualWidth ?? screen?.width ?? 1200
    const extentY = screen?.virtualHeight ?? screen?.height ?? 1000
    const stepX = Math.max(40, Math.round(extentX * 0.06))
    const stepY = Math.max(40, Math.round(extentY * 0.06))
    const targetX = origin.x + stepX < extentX - 20 ? origin.x + stepX : origin.x - stepX
    const targetY = origin.y + stepY < extentY - 20 ? origin.y + stepY : origin.y - stepY

    await virtualMouseInput('move', { x: targetX, y: targetY })
    const moved = await desktop('cursor')
    const arrived = Math.abs(moved.x - targetX) <= 3 && Math.abs(moved.y - targetY) <= 3

    // Put it back regardless, so a caller's view of the desktop is unchanged.
    try {
      await virtualMouseInput('move', { x: origin.x, y: origin.y })
    } catch {
      // The pointer is where it is; the verdict below is what matters.
    }

    virtualHidVerdict = arrived
      ? { works: true, reason: null }
      : {
          works: false,
          reason:
            `指针未移动（请求 ${targetX},${targetY}，停在 ${moved.x},${moved.y}）。` +
            '设备存在并接受报告，但系统未对其作出反应，键盘大概率同样如此。',
        }
    return virtualHidVerdict
  } catch (error) {
    virtualHidVerdict = { works: false, reason: error instanceof Error ? error.message : String(error) }
    return virtualHidVerdict
  }
}

/** Cached verdict from {@link verifyVirtualHidInput}; null until something asks for it. */
let virtualHidVerdict = null

/**
 * Is the virtual keyboard usable right now?
 *
 * The client reports whether it can find and open the device, which the driver may do while not having
 * started — but that is only half the question, and the half that is easy to answer. A keyboard that accepts
 * its reports and types nothing is worse than an absent one, because the caller has no reason to fall back.
 *
 * When the pointer canary has been run and came back negative, this reports unavailable so that callers fall
 * through to a transport that works.
 *
 * @returns {Promise<{available: boolean, reason: string|null}>} availability.
 */
export async function virtualKeyboardAvailable() {
  try {
    await virtualKeyboardInput('probe')
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }

  if (virtualHidVerdict !== null && !virtualHidVerdict.works) {
    return { available: false, reason: virtualHidVerdict.reason }
  }
  return { available: true, reason: null }
}
/**
 * Send pointer input through the virtual HID mouse.
 *
 * The same client drives both devices; this selects the mouse actions. Positions are absolute screen pixels
 * and the client converts them to the 0..32767 range the device's descriptor declares, so a caller works in
 * the same coordinates it uses everywhere else.
 *
 * The client refuses to run a move whose result it cannot confirm and exits non-zero on a rejected report, so
 * a resolved promise means the device accepted the input rather than that a request was queued.
 *
 * @param {'probe'|'move'|'click'|'dblclick'|'down'|'up'|'scroll'} action - what to send.
 * @param {object} [params] - `{ x, y, button, count, notches }`.
 * @returns {Promise<object>} `{ ok, action, exitCode }`.
 * @throws {AutomationError} when the client is missing or the device refuses the input.
 */
export async function virtualMouseInput(action, params = {}, options = {}) {
  if (!existsSync(VIRTUAL_HID_CLIENT)) {
    throw new AutomationError(
      `虚拟 HID 客户端不存在：${VIRTUAL_HID_CLIENT}。` +
        '先运行 components/vhfkey/build.ps1 构建，再运行 install-run.ps1 安装驱动。',
    )
  }

  const args = []
  switch (action) {
    case 'probe':
      args.push('probe')
      break
    case 'move':
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
        throw new AutomationError('move 需要数字的 x 与 y')
      }
      args.push('move', String(Math.round(params.x)), String(Math.round(params.y)))
      break
    case 'click':
    case 'dblclick':
      args.push(action)
      if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
        args.push(String(Math.round(params.x)), String(Math.round(params.y)))
      }
      if (params.button !== undefined) args.push('--button', String(params.button))
      if (Number.isFinite(params.count) && params.count > 1) args.push('--count', String(Math.round(params.count)))
      break
    case 'down':
    case 'up':
      args.push(action)
      if (params.button !== undefined) args.push(String(params.button))
      break
    case 'scroll':
      if (!Number.isFinite(params.notches)) {
        throw new AutomationError('scroll 需要数字的 notches')
      }
      args.push('scroll', String(Math.round(params.notches)))
      break
    default:
      throw new AutomationError(`虚拟鼠标不支持的动作：${action}`)
  }

  let stdout = ''
  try {
    const result = await run(VIRTUAL_HID_CLIENT, args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? 60_000,
      windowsHide: true,
      encoding: 'buffer',
    })
    stdout = result.stdout.toString('utf8').replace(/^\uFEFF/, '').trim()
  } catch (error) {
    const exitCode = typeof error?.code === 'number' ? error.code : 1
    stdout = (error?.stdout ?? Buffer.alloc(0)).toString('utf8').trim()
    const stderr = (error?.stderr ?? Buffer.alloc(0)).toString('utf8').trim()
    const hint = exitCode === 2 ? '（驱动未安装，或鼠标设备未启动）' : ''
    throw new AutomationError(`虚拟鼠标动作 ${action} 失败：${stderr || stdout || '(无输出)'}${hint}`)
  }

  return { ok: true, action, detail: stdout || null }
}

/**
 * Is the virtual mouse usable right now?
 *
 * The client reports whether it can open the mouse device — the driver can be installed and the node present
 * while the interface is not created, and only opening it tells the two apart.
 *
 * That is not the whole question, though. A device can be openable and accepting reports while the system
 * declines to act on them, which is indistinguishable from success at this level. When the pointer canary
 * has been run, its verdict is folded in so the answer means "it works" rather than "it answered".
 *
 * @returns {Promise<{available: boolean, reason: string|null}>} availability.
 */
export async function virtualMouseAvailable() {
  try {
    const result = await virtualMouseInput('probe')
    // The probe reports both devices; the mouse is available only if it says so.
    const openable = typeof result.detail === 'string' && /mouse=yes/.test(result.detail)
    if (!openable) {
      return { available: false, reason: 'the client did not report a mouse device' }
    }
    if (virtualHidVerdict !== null && !virtualHidVerdict.works) {
      return { available: false, reason: virtualHidVerdict.reason }
    }
    return { available: true, reason: null }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The offset from a window's own corner to its content area, in screen pixels.
 *
 * A browser reports element positions in client coordinates, which start at the content area rather
 * than at the window frame: below the title bar, the tab strip and the address bar, and inside the
 * window border. Client coordinates are therefore not screen coordinates.
 *
 * This value is NOT a constant, and treating it as one is what cost several rounds here. Measured at
 * two window positions on this machine:
 *
 *   window at (0,0)    →  content origin (11, 80)
 *   window at (24,24)  →  content origin (35,104)
 *
 * The horizontal term tracks the window position while the vertical one does not, so composing the
 * window position with a fixed chrome height does not describe reality. {@link measureContentOffset}
 * measures it instead of deriving it.
 *
 * The measurement that finally worked is indirect and worth repeating: click a series of points and
 * have the application report the client coordinate of each click. The difference between where a
 * click was aimed and where the application says it arrived is the content origin. Here it came back
 * identical across five clicks — (35,104) — which is what made it trustworthy after several
 * confidently wrong derivations.
 */
export const CONTENT_OFFSET = { x: 11, y: 80 }

/**
 * Convert a client coordinate reported by a window into a screen coordinate.
 *
 * The window's position and the content offset are separate arguments because conflating them is a
 * mistake with no visible symptom: adding the window position twice aims every click one
 * window-origin too far down and right, the click is still delivered, and it simply lands on
 * something else.
 *
 * @param {{x: number, y: number}} windowOrigin - the window's position on screen.
 * @param {{x: number, y: number}} client - the client coordinate.
 * @param {{x: number, y: number}} [offset] - content offset within the window; defaults to {@link CONTENT_OFFSET}.
 * @returns {{x: number, y: number}} the screen coordinate.
 */
export function clientToScreen(windowOrigin, client, offset = CONTENT_OFFSET) {
  return {
    x: Math.round(windowOrigin.x + offset.x + client.x),
    y: Math.round(windowOrigin.y + offset.y + client.y),
  }
}

/**
 * Convert a screen coordinate into the client coordinate a window would report for it.
 * @param {{x: number, y: number}} windowOrigin - the window's position on screen.
 * @param {{x: number, y: number}} screen - the screen coordinate.
 * @param {{x: number, y: number}} [offset] - content offset within the window; defaults to {@link CONTENT_OFFSET}.
 * @returns {{x: number, y: number}} the client coordinate.
 */
export function screenToClient(windowOrigin, screen, offset = CONTENT_OFFSET) {
  return {
    x: Math.round(screen.x - windowOrigin.x - offset.x),
    y: Math.round(screen.y - windowOrigin.y - offset.y),
  }
}

/**
 * Measure a window's content offset by clicking a known client point and asking the application
 * where the click arrived.
 *
 * The offset cannot be assumed, because chrome height varies; it can be measured in one click. The
 * provisional value is used to place the click, and the difference between where it was aimed and
 * where the application says it landed is the correction.
 *
 * The same click doubles as a liveness check on the whole path, so a measurement failure and a
 * broken input path are distinguishable: no reported arrival means the click did not reach the
 * application, which is a different problem from a wrong offset.
 *
 * @param {number} handle - the window to measure.
 * @param {{x: number, y: number}} clientPoint - a point whose client coordinate is known.
 * @param {object} options - `{ provisional, readArrival, settleMs, move, click }`.
 * @returns {Promise<{offset: {x: number, y: number}, arrived: {x: number, y: number}, aim: {x: number, y: number}, window: object}>} the measurement.
 * @throws {AutomationError} when the window is missing or the click is not observed.
 */
export async function measureContentOffset(handle, clientPoint, options = {}) {
  const window = await windowByHandle(handle)
  if (window === null) throw new AutomationError(`找不到句柄为 ${handle} 的窗口`)
  const windowOrigin = { x: window.x, y: window.y }
  const provisional = options.provisional ?? CONTENT_OFFSET
  const aim = clientToScreen(windowOrigin, clientPoint, provisional)

  const move = options.move ?? ((point) => desktop('move', { X: point.x, Y: point.y, Duration: 0.05 }))
  const press = options.click ?? ((point) => desktop('click', { X: point.x, Y: point.y, Button: 'left', Count: 1 }))
  await move(aim)
  await press(aim)
  await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 700))

  const arrived = await options.readArrival()
  if (arrived === null || arrived === undefined) {
    throw new AutomationError(
      '点击已发出，但目标应用没有报告落点，无法反解内容区偏移。' +
        '需要应用能把点击坐标读回来（浏览器可以监听 click 事件读 clientX/clientY）。',
    )
  }
  return {
    offset: { x: aim.x - windowOrigin.x - arrived.x, y: aim.y - windowOrigin.y - arrived.y },
    arrived,
    aim,
    window: { x: window.x, y: window.y, width: window.width, height: window.height },
  }
}

/**
 * The pointer's hotspot offset, in device pixels.
 *
 * A click is delivered at the pointer's hotspot, which is the tip of the arrow rather than its
 * centre. Measured here as negligible compared with the content offset above, and kept separate so
 * that a machine which does need a correction can apply one without touching the window maths.
 */
export const POINTER_HOTSPOT = { x: 0, y: 0 }

/** Raised when an automation step cannot be carried out. */
export class AutomationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AutomationError'
  }
}

/**
 * Invoke the desktop helper.
 * @param {string} action - the helper's action name.
 * @param {object} [params] - parameters, mapped onto the helper's switches.
 * @param {object} [options] - `{ timeoutMs }`.
 * @returns {Promise<object>} the parsed JSON result.
 * @throws {AutomationError} when the helper is missing or the step fails.
 */
export async function desktop(action, params = {}, options = {}) {
  if (!existsSync(DESKTOP_SCRIPT)) {
    throw new AutomationError(`找不到桌面自动化脚本：${DESKTOP_SCRIPT}`)
  }
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DESKTOP_SCRIPT, '-Action', action]
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    args.push(`-${key}`, String(value))
  }

  try {
    const { stdout } = await run('powershell.exe', args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? 60_000,
      windowsHide: true,
      encoding: 'buffer',
    })
    const text = decodePowerShell(stdout)
    if (text === '') throw new AutomationError(`桌面动作 ${action} 没有返回任何内容`)
    try {
      return JSON.parse(text)
    } catch {
      // Some actions answer with a bare string rather than an object.
      return { value: text }
    }
  } catch (error) {
    if (error instanceof AutomationError) throw error
    const detail = String(error?.stderr ?? error?.message ?? error).trim()
    throw new AutomationError(`桌面动作 ${action} 失败：${detail.slice(0, 400)}`)
  }
}

/**
 * Decode a helper's stdout as UTF-8 and strip a byte-order mark.
 *
 * Every helper sets [Console]::OutputEncoding to UTF-8, but decoding here is still explicit
 * because the failure is silent and expensive: without it, Chinese read from the screen arrives as
 * replacement characters, JSON still parses, and every text lookup simply finds nothing. That
 * exact bug cost several rounds before it was traced.
 *
 * @param {Buffer|string} stdout - the captured output, ideally as a Buffer.
 * @returns {string} the decoded text, trimmed.
 */
function decodePowerShell(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout)
  return text.replace(/^\uFEFF/, '').trim()
}

/**
 * Read text off an image, with positions.
 *
 * The positions are what make this useful for automation rather than just reporting: a label can
 * be found and clicked without the caller knowing any coordinates in advance.
 *
 * @param {string} imagePath - the PNG to read.
 * @param {object} [options] - `{ region: {x,y,width,height}, scale, language }`.
 * @returns {Promise<{language: string, lineCount: number, elapsedMs: number, lines: {text: string, x: number, y: number, width: number, height: number}[]}>} recognised lines.
 * @throws {AutomationError} when OCR cannot run.
 */
export async function ocr(imagePath, options = {}) {
  if (!existsSync(imagePath)) throw new AutomationError(`OCR 的输入图片不存在：${imagePath}`)
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, '-Path', imagePath]
  if (options.scale !== undefined) args.push('-Scale', String(options.scale))
  if (options.language !== undefined) args.push('-Language', options.language)
  if (options.region !== undefined) {
    const { x, y, width, height } = options.region
    args.push('-Region', `${x},${y},${width},${height}`)
  }

  try {
    const { stdout } = await run('powershell.exe', args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? 60_000,
      windowsHide: true,
      encoding: 'buffer',
    })
    // Decode as UTF-8 explicitly rather than relying on the process default. The helper sets
    // [Console]::OutputEncoding to UTF-8, but a mismatch here is invisible: recognised Chinese
    // arrives as replacement characters and every text lookup simply finds nothing.
    const text = stdout.toString('utf8').replace(/^\uFEFF/, '').trim()
    if (text === '') throw new AutomationError('OCR 没有输出')
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof AutomationError) throw error
    const detail = String(error?.stderr ?? error?.message ?? error).trim()
    throw new AutomationError(`OCR 失败：${detail.slice(0, 400)}`)
  }
}

/**
 * Capture the screen, or one window, to a PNG.
 * @param {string} target - destination path.
 * @param {object} [options] - `{ handle }` to capture one window, or `{ region }` for a rectangle.
 * @returns {Promise<{path: string, x: number, y: number, width: number, height: number}>} what was captured.
 */
export async function screenshot(target, options = {}) {
  mkdirSync(dirname(resolve(target)), { recursive: true })
  const params = { Path: resolve(target) }
  if (options.handle !== undefined) params.X = options.handle
  if (options.region !== undefined) {
    const { x, y, width, height } = options.region
    params.Region = `${x},${y},${width},${height}`
  }
  return desktop('screenshot', params)
}

/**
 * List the visible top-level windows, with titles, process ids, and bounds.
 * @returns {Promise<{handle: number, pid: number, title: string, x: number, y: number, width: number, height: number}[]>} the windows.
 */
export async function windows() {
  const result = await desktop('windows')
  // `windows` answers with a bare JSON array, which the helper passes through as a string.
  if (Array.isArray(result)) return result
  if (typeof result.value === 'string') {
    try {
      return JSON.parse(result.value)
    } catch {
      throw new AutomationError(`无法解析窗口列表：${result.value.slice(0, 200)}`)
    }
  }
  return []
}

/**
 * Find a window by a case-insensitive substring of its title, or by process id.
 * @param {object} query - `{ title?: string, pid?: number, minWidth?: number }`.
 * @returns {Promise<object|null>} the matching window, or null.
 */
export async function findWindow(query = {}) {
  const all = await windows()
  const matches = all.filter((entry) => {
    if (query.pid !== undefined && entry.pid !== query.pid) return false
    if (query.title !== undefined && !entry.title.toLowerCase().includes(String(query.title).toLowerCase())) return false
    if (query.minWidth !== undefined && entry.width < query.minWidth) return false
    return true
  })
  return matches[0] ?? null
}

/**
 * The primary display's size, in pixels.
 * @returns {Promise<{width: number, height: number}>} the size.
 */
export async function screenSize() {
  const info = await desktop('screen')
  return { width: info.width, height: info.height }
}

/**
 * Click a location given in a window's client coordinates.
 *
 * This is the entry point for anything that knows where a control is relative to the content area
 * — a browser's `getBoundingClientRect`, an accessibility API, or a recorded coordinate — rather
 * than in screen pixels. The conversion is done here so the caller never has to remember that
 * client coordinates start below the browser chrome.
 *
 * @param {number} handle - the target window.
 * @param {{x: number, y: number}} client - the position within the content area.
 * @param {object} [options] - `{ button, count, double }`.
 * @returns {Promise<object>} the click outcome, including the screen coordinate used.
 * @throws {AutomationError} when the window cannot be found or is not in front.
 */
export async function clickClient(handle, client, options = {}) {
  const target = await windowByHandle(handle)
  if (target === null) throw new AutomationError(`找不到句柄为 ${handle} 的窗口，无法换算坐标`)
  const windowOrigin = { x: target.x, y: target.y }
  const offset = options.offset ?? CONTENT_OFFSET
  const screen = clientToScreen(windowOrigin, client, offset)
  const outcome = await click({ ...screen, handle, ...options })
  return { ...outcome, client, windowOrigin, offset, screen }
}

/**
 * Find a window by its handle.
 * @param {number} handle - the window handle.
 * @returns {Promise<object|null>} the window, or null.
 */
export async function windowByHandle(handle) {
  const all = await windows()
  return all.find((entry) => Number(entry.handle) === Number(handle)) ?? null
}

/**
 * The current pointer position.
 * @returns {Promise<{x: number, y: number}>} the position.
 */
export async function cursor() {
  return desktop('cursor')
}

/**
 * Move the pointer and click.
 *
 * When a handle is given, the window is brought to the front first and the click is withheld
 * unless it really arrived there: input sent while another window is in front goes to that other
 * window, which is how a stray click damages something the caller never intended to touch.
 *
 * The point is also checked against the window that owns it, because a fully visible window can
 * still be covered by another one.
 *
 * @param {object} spec - the click.
 * @param {number} spec.x - screen x.
 * @param {number} spec.y - screen y.
 * @param {number} [spec.handle] - the window this click is meant for.
 * @param {string} [spec.button] - `'left'`, `'right'`, or `'middle'`.
 * @param {number} [spec.count] - click count.
 * @param {boolean} [spec.double] - convenience for `count: 2`.
 * @returns {Promise<{x: number, y: number, owner: object|null, front: object|null}>} where the click went.
 * @throws {AutomationError} when the intended window is not in front, or does not own the point.
 */
export async function click(spec) {
  const { x, y } = spec
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new AutomationError('click 需要数字类型的 x 和 y 坐标')
  }

  let front = null
  if (spec.handle !== undefined) {
    await desktop('focus', { X: spec.handle })
    front = await desktop('foreground')
    if (Number(front.handle) !== Number(spec.handle)) {
      throw new AutomationError(
        `拒绝点击：目标是窗口 ${spec.handle}（"${front.title}"），但当前前台是 ${front.handle}。` +
          '真实输入会送到前台窗口，点下去就会打到别的程序上。',
      )
    }
  }

  // Ask what owns the point, so a covered window cannot be clicked through silently.
  const owner = await desktop('atpoint', { X: Math.round(x), Y: Math.round(y) })
  if (spec.handle !== undefined && owner.handle !== undefined && Number(owner.handle) !== Number(spec.handle)) {
    throw new AutomationError(
      `拒绝点击：坐标 ${Math.round(x)},${Math.round(y)} 属于窗口 ${owner.handle}（"${owner.title}"），不是目标 ${spec.handle}。`,
    )
  }

  const count = spec.double === true ? 2 : spec.count ?? 1
  const button = spec.button ?? 'left'

  // Mouse input prefers the driver. Move first and then click, because a real pointer always travels
  // to a target before it presses, and some controls hit-test against the last known position or a
  // hover state, so a press arriving without a preceding move can land on nothing.
  //
  // The driver path is attempted first and falls back to SendInput on any failure, so a machine
  // without the driver — or one where it rejects the request — still works rather than failing the
  // whole action. The fallback is reported so a caller can tell which transport actually ran.
  // The virtual mouse is tried first: it is a real HID device, so nothing above the HID layer can treat its
  // input as synthetic, and its absolute positioning is accurate to within a pixel. The Interception filter
  // follows, then SendInput, so a machine without the virtual device still works and the transport that ran
  // is reported rather than assumed.
  const order = spec.transport
    ? [spec.transport]
    : TRANSPORT_PREFERENCE.mouse
  const failures = []

  for (const transport of order) {
    try {
      /*
       * Move, confirm the pointer arrived, and only then click.
       *
       * The order matters and the confirmation is not optional. A transport can accept a request without
       * producing any input — that is what a virtual HID device does when something above the HID layer is
       * taking the input instead — and nothing about the call says so. Moving and clicking as one step then
       * puts the click wherever the pointer happened to be, which can activate anything at all.
       *
       * Confirming first makes a transport that cannot position itself fall through to the next one, and it
       * makes a click impossible to place on a target that was never reached.
       */
      if (transport === 'virtualmouse') {
        await virtualMouseInput('move', { x, y })
      } else if (transport === 'driver') {
        await driverInput('move', { X: Math.round(x), Y: Math.round(y) })
      } else if (transport === 'sendinput') {
        await desktop('move', { X: Math.round(x), Y: Math.round(y), Duration: spec.travel ?? 0.05 })
      } else {
        throw new AutomationError(`未知的输入传输：${transport}`)
      }

      const at = await desktop('cursor')
      // Three pixels of slack: absolute positioning quantises the desktop onto 0..32767 and rounds.
      if (Math.abs(at.x - Math.round(x)) > 3 || Math.abs(at.y - Math.round(y)) > 3) {
        throw new AutomationError(`指针未到达目标（停在 ${at.x},${at.y}）`)
      }

      // The pointer is on the target, so the click can only land there.
      if (transport === 'virtualmouse') {
        // A double click is requested as such, so the device sends a real double-click sequence rather than
        // two clicks that the target may or may not pair up.
        await virtualMouseInput(count > 1 && spec.double === true ? 'dblclick' : 'click', {
          x,
          y,
          button,
          count,
        })
      } else if (transport === 'driver') {
        await driverInput('click', { X: Math.round(x), Y: Math.round(y), Button: button, Count: count })
      } else {
        await desktop('click', { X: Math.round(x), Y: Math.round(y), Button: button, Count: count })
      }

      return {
        x: at.x,
        y: at.y,
        owner: owner.handle === undefined ? null : owner,
        front,
        transport,
      }
    } catch (error) {
      failures.push(`${transport}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new AutomationError(`所有鼠标传输都失败：${failures.join(' | ')}`)
}

/**
 * Locate a piece of text on screen, in screen coordinates.
 *
 * A screenshot is taken, OCR reads it, and the matches are returned. When a window handle is
 * given the capture is limited to that window and the coordinates are converted back to screen
 * space, so they can be clicked directly.
 *
 * @param {string} needle - the text to look for. Matching is case-insensitive and ignores the
 *   spaces some OCR engines insert between CJK glyphs.
 * @param {object} [options] - `{ handle, screenshotPath, scale, exact }`.
 * @returns {Promise<{found: boolean, matches: object[], shot: string, lineCount: number, elapsedMs: number}>} the matches, in screen coordinates.
 */
export async function findText(needle, options = {}) {
  const target = options.screenshotPath ?? resolve(PLUGIN_ROOT, 'tmp', 'automation-look.png')
  let originX = 0
  let originY = 0

  let result
  if (options.handle !== undefined) {
    // Capture by window handle, then translate the OCR result into screen space.
    const shot = await screenshot(target, { handle: options.handle })
    originX = shot.x
    originY = shot.y
    result = await ocr(target, { scale: options.scale ?? 2 })
  } else {
    await screenshot(target)
    result = await ocr(target, { scale: options.scale ?? 2 })
  }

  const wanted = normalise(needle)
  const matches = []
  for (const line of result.lines ?? []) {
    const haystack = normalise(line.text)
    const hit = options.exact === true ? haystack === wanted : haystack.includes(wanted)
    if (!hit) continue
    // Report the centre of the matched line: clicking a label's centre is what a person does.
    matches.push({
      text: line.text,
      x: originX + line.x + Math.round((line.width ?? 0) / 2),
      y: originY + line.y + Math.round((line.height ?? 0) / 2),
      left: originX + line.x,
      top: originY + line.y,
      width: line.width,
      height: line.height,
    })
  }

  return {
    found: matches.length > 0,
    matches,
    shot: target,
    lineCount: result.lineCount ?? 0,
    elapsedMs: result.elapsedMs ?? null,
  }
}

/**
 * Find a piece of text and click it.
 *
 * This is the whole point of the module: the caller names a label, and the pointer goes to it.
 * When the label cannot be found the click does NOT happen — there is no fallback to a guessed
 * coordinate, because a wrong click in an unknown application is worse than no click.
 *
 * @param {string} needle - the label to click.
 * @param {object} [options] - `{ handle, index, scale, button }`.
 * @returns {Promise<{clicked: boolean, target: object|null, reason?: string, at?: object}>} the outcome.
 * @throws {AutomationError} when the window is not in front, so the click would go elsewhere.
 */
export async function clickText(needle, options = {}) {
  // Bring the target to the front first: the capture must show the same state the click will
  // act on, and a window behind another one can be captured but not clicked.
  if (options.handle !== undefined) {
    await desktop('focus', { X: options.handle })
    const front = await desktop('foreground')
    if (Number(front.handle) !== Number(options.handle)) {
      throw new AutomationError(`拒绝操作：目标窗口 ${options.handle} 不在前台（当前是 ${front.handle} "${front.title}"）`)
    }
  }

  const located = await findText(needle, options)
  if (!located.found) {
    return { clicked: false, target: null, reason: `屏幕上找不到 "${needle}"（OCR 读到 ${located.lineCount} 行）` }
  }

  const index = options.index ?? 0
  const target = located.matches[index]
  if (target === undefined) {
    return { clicked: false, target: null, reason: `只找到 ${located.matches.length} 处 "${needle}"，取不到第 ${index + 1} 处` }
  }

  const at = await click({ x: target.x, y: target.y, handle: options.handle, button: options.button })
  return { clicked: true, target, at }
}

/**
 * Type text into whatever has focus.
 *
 * The transports are tried in the order {@link TRANSPORT_PREFERENCE} gives for `keyboard`, and each
 * failure falls through to the next rather than aborting: a machine without the virtual keyboard
 * installed still types through SendInput, and a target that ignores user-mode injection can be served by
 * naming a transport explicitly.
 *
 *   virtualkbd  a real HID device, so nothing above the HID layer can treat the input as synthetic
 *   sendinput   dependable, needs no installation
 *   driver      the Interception filter; on this machine it accepts keystrokes and delivers none
 *
 * The transport that actually ran is returned, so a caller can tell which one it got instead of assuming.
 *
 * @param {string} text - the text to type.
 * @param {object} [options] - `{ transport, delayMs }`.
 * @returns {Promise<object>} the helper's report, with the transport that ran.
 */
export async function typeText(text, options = {}) {
  const order = keyboardOrder(options.transport)
  const failures = []

  for (const transport of order) {
    try {
      if (transport === 'virtualkbd') {
        const result = await virtualKeyboardInput('type', { text })
        return { ...result, transport: 'virtualkbd' }
      }
      if (transport === 'driver') {
        const result = await driverInput('text', { Keys: text, DelayMs: options.delayMs ?? 18 })
        return { ...result, transport: 'driver' }
      }
      if (transport === 'sendinput') {
        const result = await desktop('text', { Text: text })
        return { ...result, transport: 'sendinput' }
      }
      throw new AutomationError(`未知的输入传输：${transport}`)
    } catch (error) {
      failures.push(`${transport}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new AutomationError(`所有键盘传输都失败：${failures.join(' | ')}`)
}

/**
 * Send a key, by name or as a SendKeys chord.
 *
 * Transport order is the same as {@link typeText}. The two are not interchangeable: `virtualkbd` and
 * `driver` take a key name (`ENTER`, `TAB`, `A`) or a combination, while `sendinput` takes the SendKeys
 * grammar (`^a` for Ctrl+A, `%{F4}` for Alt+F4). A caller that needs a chord and does not care which
 * transport runs should pass the chord, because it is translated for the device transports:
 * `sendKey('^a')` becomes a CTRL+A combination on the virtual keyboard.
 *
 * @param {string} chord - the key or chord.
 * @param {object} [options] - `{ transport, delayMs }`.
 * @returns {Promise<object>} the helper's report, with the transport that ran.
 */
export async function sendKey(chord, options = {}) {
  const order = keyboardOrder(options.transport)
  const failures = []

  // The SendKeys grammar is what SendInput understands; the device transports want a key name. The
  // translation is attempted up front so all three can be tried for the same logical request.
  const decoded = decodeKeyChord(chord)

  for (const transport of order) {
    try {
      if (transport === 'virtualkbd') {
        const result = decoded
          ? decoded.modifier
            ? await virtualKeyboardInput('combo', { modifier: decoded.modifier, key: decoded.key })
            : await virtualKeyboardInput('key', { key: decoded.key })
          : await virtualKeyboardInput('key', { key: chord })
        return { ...result, transport: 'virtualkbd' }
      }
      if (transport === 'driver') {
        const result = await driverInput('key', { Keys: decoded?.key ?? chord, DelayMs: options.delayMs ?? 18 })
        return { ...result, transport: 'driver' }
      }
      if (transport === 'sendinput') {
        const result = await desktop('key', { Text: chord })
        return { ...result, transport: 'sendinput' }
      }
      throw new AutomationError(`未知的输入传输：${transport}`)
    } catch (error) {
      failures.push(`${transport}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new AutomationError(`所有键盘传输都失败：${failures.join(' | ')}`)
}

/**
 * Translate the SendKeys grammar into a modifier and a key name.
 *
 * Only the forms that actually occur are handled — a leading `^`, `%` or `+` modifier, and `{NAME}` — and
 * anything unrecognised returns null, which makes the caller fall back to passing the string through
 * untouched. Guessing at the rest of the grammar would be worse than not understanding it.
 *
 * @param {string} chord - for example `^a`, `%{F4}`, `{ENTER}` or `A`.
 * @returns {{modifier: string|null, key: string}|null} the decoded chord, or null when it is not one.
 */
export function decodeKeyChord(chord) {
  if (typeof chord !== 'string' || chord.length === 0) return null

  const modifiers = { '^': 'CTRL', '%': 'ALT', '+': 'SHIFT' }
  let rest = chord
  let modifier = null

  if (modifiers[rest[0]]) {
    modifier = modifiers[rest[0]]
    rest = rest.slice(1)
  }

  const braced = /^\{([^}]+)\}$/.exec(rest)
  if (braced) {
    const name = braced[1].toUpperCase()
    // SendKeys names a few keys differently from the HID usage table.
    const aliases = { RETURN: 'ENTER', ESCAPE: 'ESC', DEL: 'DELETE', INS: 'INSERT', BACK: 'BACKSPACE' }
    return { modifier, key: aliases[name] ?? name }
  }

  // A single character maps to its own key; longer unbraced text is not a chord and is left alone.
  if (rest.length === 1) return { modifier, key: rest.toUpperCase() }
  if (modifier === null) return null
  return { modifier, key: rest.toUpperCase() }
}

/**
 * Normalise text for matching: lower case, and with the spacing OCR inserts between CJK glyphs
 * removed so `音 频` matches `音频`.
 * @param {string} value - the text.
 * @returns {string} the comparable form.
 */
function normalise(value) {
  return String(value).toLowerCase().replace(/\s+/g, '')
}
