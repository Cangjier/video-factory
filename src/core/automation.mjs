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
 * The input transports available for pointer actions.
 *
 * `sendinput` injects at user level through the Win32 input API. `driver` sends through the
 * Interception filter driver, which sits below that boundary in the input stack.
 *
 * Both were measured working on this machine, including on a browser button. The driver is the
 * more faithful transport — nothing in the stack can tell its events from a device's own — and it
 * is the one to reach for when a target treats synthetic input as a different class of event,
 * which is common in games and in software that reads raw device state.
 *
 * Note the honest history: an earlier conclusion that SendInput could not activate a browser
 * button was wrong, and the real fault was the coordinate arithmetic above. The driver is a
 * fallback for targets that need it, not a fix for mis-aimed clicks.
 */
export const INPUT_TRANSPORTS = ['sendinput', 'driver']

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
    const detail = String(error?.stderr ?? error?.message ?? error).trim()
    throw new AutomationError(`驱动动作 ${action} 失败：${detail.slice(0, 400)}`)
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
 * The offset from a window's own corner to its content area, in screen pixels.
 *
 * A browser reports element positions in client coordinates, which start at the content area
 * rather than at the window frame: below the title bar, the tab strip and the address bar, and
 * inside the window border. Client coordinates are therefore not screen coordinates.
 *
 * Measured on this machine for a window at (40,30): the content origin is at screen (51,110), so
 * this offset is (11,80). Chrome height dominates the vertical part and varies with what the
 * browser is showing — a bookmarks bar adds roughly 30 px — so treat this as a default to be
 * measured, not a constant to be trusted. {@link measureContentOffset} derives it by clicking.
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
  // Move first, then click. A real pointer always travels to a target before it presses, and some
  // controls hit-test against the last known position or a hover state, so a press that arrives
  // without a preceding move can land on nothing.
  await desktop('move', { X: Math.round(x), Y: Math.round(y), Duration: spec.travel ?? 0.05 })
  await desktop('click', {
    X: Math.round(x),
    Y: Math.round(y),
    Button: spec.button ?? 'left',
    Count: count,
  })

  const at = await desktop('cursor')
  return { x: at.x, y: at.y, owner: owner.handle === undefined ? null : owner, front }
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
 * @param {string} text - the text to type.
 * @returns {Promise<object>} the helper's report.
 */
export async function typeText(text) {
  return desktop('text', { Text: text })
}

/**
 * Send a key chord, using the SendKeys grammar (`^a` for Ctrl+A, `{ENTER}`, `%{F4}`).
 * @param {string} chord - the chord.
 * @returns {Promise<object>} the helper's report.
 */
export async function sendKey(chord) {
  return desktop('key', { Text: chord })
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
