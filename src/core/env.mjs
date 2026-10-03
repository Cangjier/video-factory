/**
 * Environment facts: where the plugin lives, and whether its external tools exist.
 *
 * Binary discovery follows the same precedence the reference implementation used —
 * explicit override, then the vendored build, then PATH — because a vendored
 * ffmpeg is what makes a render reproducible across machines while a PATH ffmpeg
 * keeps a fresh clone working.
 *
 * @module video-factory/core/env
 */
import { existsSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Plugin package root, resolved from this module so a `link:` install still works. */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const BINARY_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const PROBE_NAME = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

/**
 * Resolve the working directory for one request.
 *
 * @param {object} config - normalized plugin config.
 * @param {string} [requested] - a caller-supplied directory.
 * @returns {string} an absolute working directory.
 */
export function resolveCwd(config, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return resolve(requested)
  if (typeof config.projectRoot === 'string' && config.projectRoot.trim() !== '') return resolve(config.projectRoot)
  return PLUGIN_ROOT
}

/**
 * Locate one binary: explicit config, then the vendored build, then PATH.
 *
 * @param {string} stem - `ffmpeg` or `ffprobe`.
 * @param {string|null} explicit - a configured path.
 * @returns {string|null} an existing absolute path, or null when none is found.
 */
export function resolveBinary(stem, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '' && existsSync(explicit)) return resolve(explicit)

  const name = stem === 'ffmpeg' ? BINARY_NAME : PROBE_NAME
  const vendored = join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'bin', name)
  if (existsSync(vendored)) return vendored

  // PATH lookup without spawning a shell: `where`/`which` is one place to handle
  // both platforms, and a missing binary simply reports not found.
  const pathEntries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const entry of pathEntries) {
    if (entry.trim() === '') continue
    const candidate = join(entry, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Vendored or PATH font directory candidates, in preference order.
 * @returns {string[]} candidate directories.
 */
export function fontDirectories() {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  return [join(windir, 'Fonts')]
}

/**
 * Read the first line of a binary's `-version` output.
 * @param {string} binary - absolute path to an executable.
 * @returns {Promise<string|null>} the version line, or null on failure.
 */
export async function versionOf(binary) {
  try {
    const { stdout, stderr } = await run(binary, ['-version'], { timeout: 15000, windowsHide: true })
    const text = `${stdout}${stderr}`.split('\n').find((line) => line.trim() !== '')
    return text ? text.trim() : null
  } catch {
    return null
  }
}

/**
 * Ask ffmpeg which encoders and filters it has.
 *
 * The pipeline depends on libx264, aac, and a specific filter set; reporting them
 * up front turns an obscure mid-render failure into a clear environment problem.
 * @param {string} binary - absolute path to ffmpeg.
 * @returns {Promise<{encoders: string[], filters: string[]}>} capability lists.
 */
export async function capabilitiesOf(binary) {
  const wanted = {
    encoders: ['libx264', 'libx265', 'aac'],
    filters: [
      'drawtext', 'subtitles', 'ass', 'zoompan', 'xfade', 'acrossfade', 'loudnorm',
      'sidechaincompress', 'amix', 'atempo', 'gblur', 'tile', 'afade', 'concat',
    ],
  }
  const result = { encoders: [], filters: [] }
  try {
    const { stdout } = await run(binary, ['-hide_banner', '-encoders'], { timeout: 20000, windowsHide: true, maxBuffer: 8 << 20 })
    result.encoders = wanted.encoders.filter((name) => new RegExp(`\\b${name}\\b`).test(stdout))
  } catch {
    /* leave encoders empty; the caller reports what is missing */
  }
  try {
    const { stdout } = await run(binary, ['-hide_banner', '-filters'], { timeout: 20000, windowsHide: true, maxBuffer: 8 << 20 })
    result.filters = wanted.filters.filter((name) => new RegExp(`\\b${name}\\b`).test(stdout))
  } catch {
    /* as above */
  }
  return result
}

/**
 * Report whether the vendored ffmpeg build is present, without running anything.
 * @returns {{present: boolean, directory: string, files: string[]}} vendored build facts.
 */
export function vendoredBuild() {
  const directory = join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'bin')
  if (!existsSync(directory)) return { present: false, directory, files: [] }
  try {
    return { present: true, directory, files: readdirSync(directory) }
  } catch {
    return { present: true, directory, files: [] }
  }
}
