/**
 * Fetching a rendered page.
 *
 * A plain HTTP GET is enough for most documentation, but a client-rendered site returns an
 * empty body: the text is produced by JavaScript that `fetch` never runs. Rather than drive
 * a mouse to work around that, this asks a browser to render the page and hands back the
 * finished DOM — the same thing a reader would see, obtained without touching the desktop.
 *
 * The browser is launched as a separate headless process against a throwaway profile, so it
 * neither disturbs nor depends on whatever browser session the user has open.
 *
 * @module video-factory/core/render
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const run = promisify(execFile)

/** Browsers to try, in order. The first one that exists wins. */
export const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/** Raised when a page cannot be retrieved or rendered. */
export class RenderError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RenderError'
  }
}

/**
 * Find a browser that can render headlessly.
 * @returns {string} the browser path.
 * @throws {RenderError} when none of the known locations has one.
 */
export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  throw new RenderError(
    `找不到可用于渲染的浏览器。已尝试：\n  ${BROWSER_CANDIDATES.join('\n  ')}\n` +
      '可以安装 Microsoft Edge 或 Google Chrome，或用 --browser 显式指定路径。',
  )
}

/**
 * Render a URL in a headless browser and return the finished DOM.
 *
 * `--virtual-time-budget` is what makes this reliable: it lets the page's timers and network
 * activity settle before the DOM is dumped, so a page that fetches its content after load
 * still arrives complete.
 *
 * @param {string} url - the page to render.
 * @param {object} [options] - render options.
 * @param {string} [options.browser] - browser path; discovered when omitted.
 * @param {number} [options.waitMs] - virtual time budget. Defaults to 15000.
 * @param {number} [options.timeoutMs] - hard limit. Defaults to 90000.
 * @returns {Promise<{html: string, browser: string, bytes: number}>} the rendered DOM.
 * @throws {RenderError} when the browser fails or produces nothing.
 */
export async function renderUrl(url, options = {}) {
  const browser = options.browser ?? findBrowser()
  const profile = mkdtempSync(join(tmpdir(), 'vf-render-'))
  const waitMs = options.waitMs ?? 15_000

  try {
    const { stdout } = await run(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        `--virtual-time-budget=${waitMs}`,
        '--dump-dom',
        url,
      ],
      { maxBuffer: 256 * 1024 * 1024, timeout: options.timeoutMs ?? 90_000, windowsHide: true },
    )
    if (typeof stdout !== 'string' || stdout.trim() === '') {
      throw new RenderError(`浏览器没有为 ${url} 输出任何 DOM。可能该页面需要登录，或加载超时。`)
    }
    return { html: stdout, browser, bytes: Buffer.byteLength(stdout) }
  } catch (error) {
    if (error instanceof RenderError) throw error
    throw new RenderError(`渲染 ${url} 失败：${error?.message ?? error}`)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}

/**
 * Turn HTML into readable text.
 *
 * Block-level boundaries become newlines *before* tags are stripped, so paragraphs, list
 * items, and table cells do not run together — which matters because API documentation is
 * mostly tables, and a flattened table is unreadable.
 *
 * @param {string} html - the rendered HTML.
 * @returns {string} the extracted text.
 */
export function htmlToText(html) {
  let text = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  text = text
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|div|li|tr|h[1-6]|pre|section|article|table|thead|tbody)\s*>/gi, '\n')
    .replace(/<\s*(li|tr)\b[^>]*>/gi, '\n- ')
    .replace(/<\s*(td|th)\b[^>]*>/gi, ' | ')

  text = text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    // Collapse the runs of blank lines that tag stripping leaves behind.
    .filter((line, index, all) => line !== '' || (all[index - 1] ?? '') !== '')

  return lines.join('\n').trim()
}

/**
 * Fetch a page's visible text, rendering it when a plain request comes back empty.
 *
 * The plain request is tried first because it is far cheaper; the browser is only started
 * when the page turns out to be client-rendered.
 *
 * @param {string} url - the page to fetch.
 * @param {object} [options] - options, forwarded to {@link renderUrl} when rendering.
 * @param {boolean} [options.forceRender] - skip the plain request and render immediately.
 * @returns {Promise<{text: string, rendered: boolean, bytes: number, browser: string|null}>} the page text.
 * @throws {RenderError} when neither route yields content.
 */
export async function fetchRenderedText(url, options = {}) {
  if (options.forceRender !== true) {
    try {
      const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } })
      const body = await response.text()
      // A client-rendered shell is not empty — it is a stub with no prose. Size alone
      // therefore cannot decide; the rendered path is taken when the plain body looks like
      // an application shell rather than a document.
      const looksLikeShell =
        /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(body) ||
        (body.length > 0 && htmlToText(body).length < 400 && /<script/i.test(body))
      if (response.ok && !looksLikeShell) {
        return { text: htmlToText(body), rendered: false, bytes: body.length, browser: null }
      }
    } catch {
      // Fall through to rendering; a network failure here is not necessarily fatal.
    }
  }

  const rendered = await renderUrl(url, options)
  return {
    text: htmlToText(rendered.html),
    rendered: true,
    bytes: rendered.bytes,
    browser: rendered.browser,
  }
}

export { readFileSync }
