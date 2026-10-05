/**
 * Environment facts: where the plugin lives, and whether its external tools exist.
 *
 * Binary discovery follows one order everywhere in this family: an explicit configured path, then
 * the plugin's environment variable, then **the shared plugin home** (`~/.dsh-plugins/ffmpeg/bin`,
 * one build for all six plugins), then the legacy `vendor/ffmpeg/bin`, then PATH. The shared home
 * is what makes a render reproducible across machines without six copies of the same 200 MB, and
 * the `vendor/` directory stays as a candidate so a machine that installed a build before the
 * shared home existed does not download it again.
 *
 * @module video-factory/core/env
 */
import { existsSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PLUGIN_ROOT, SHARED_FFMPEG_BIN, SHARED_FFMPEG_DIR, binaryName, sharedHomeState } from './home.mjs'

const run = promisify(execFile)

export { PLUGIN_ROOT }

/** Environment variable that names an ffmpeg executable outright, shared with the other plugins. */
export const FFMPEG_ENV = 'DSH_FFMPEG'

/** Environment variable that names an ffprobe executable outright, shared with the other plugins. */
export const FFPROBE_ENV = 'DSH_FFPROBE'

/** This plugin's own environment variable, kept because it was documented first. */
export const LEGACY_FFMPEG_ENV = 'VIDEO_FACTORY_FFMPEG'

/** The matching ffprobe variable. */
export const LEGACY_FFPROBE_ENV = 'VIDEO_FACTORY_FFPROBE'

const BINARY_NAME = binaryName('ffmpeg')
const PROBE_NAME = binaryName('ffprobe')

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
 * Locate one binary and say which rule produced it.
 *
 * @param {string} stem - `ffmpeg` or `ffprobe`.
 * @param {string|null} explicit - a configured path.
 * @returns {{path: string, source: 'config'|'env'|'home'|'vendor'|'path'}|null} where it was found, or null.
 */
export function findBinary(stem, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '' && existsSync(explicit)) {
    return { path: resolve(explicit), source: 'config' }
  }

  const name = stem === 'ffmpeg' ? BINARY_NAME : PROBE_NAME
  const envNames =
    stem === 'ffmpeg' ? [FFMPEG_ENV, LEGACY_FFMPEG_ENV] : [FFPROBE_ENV, LEGACY_FFPROBE_ENV]
  for (const variable of envNames) {
    const value = process.env[variable]
    if (typeof value === 'string' && value.trim() !== '' && existsSync(value)) {
      return { path: resolve(value), source: 'env' }
    }
  }

  const shared = join(SHARED_FFMPEG_BIN, name)
  if (existsSync(shared)) return { path: shared, source: 'home' }

  const vendored = join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'bin', name)
  if (existsSync(vendored)) return { path: vendored, source: 'vendor' }

  // PATH lookup without spawning a shell: `where`/`which` is one place to handle
  // both platforms, and a missing binary simply reports not found.
  const pathEntries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const entry of pathEntries) {
    if (entry.trim() === '') continue
    const candidate = join(entry, name)
    if (existsSync(candidate)) return { path: candidate, source: 'path' }
  }
  return null
}

/**
 * Locate one binary: explicit config, then the environment, then the shared home, then the legacy
 * vendor directory, then PATH.
 *
 * @param {string} stem - `ffmpeg` or `ffprobe`.
 * @param {string|null} explicit - a configured path.
 * @returns {string|null} an existing absolute path, or null when none is found.
 */
export function resolveBinary(stem, explicit) {
  return findBinary(stem, explicit)?.path ?? null
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
 * Which directory this plugin's build is read from and installed into.
 *
 * The shared home when it holds a build, otherwise the legacy `vendor/ffmpeg` when that one does,
 * otherwise the shared home — the place an install is about to create.
 *
 * @returns {{directory: string, binDir: string, source: 'home'|'vendor'}} the resolved install location.
 */
export function installLocation() {
  for (const candidate of [
    { directory: SHARED_FFMPEG_DIR, binDir: SHARED_FFMPEG_BIN, source: 'home' },
    { directory: join(PLUGIN_ROOT, 'vendor', 'ffmpeg'), binDir: join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'bin'), source: 'vendor' },
  ]) {
    if (existsSync(join(candidate.binDir, BINARY_NAME)) || existsSync(join(candidate.binDir, PROBE_NAME))) return candidate
  }
  return { directory: SHARED_FFMPEG_DIR, binDir: SHARED_FFMPEG_BIN, source: 'home' }
}

/**
 * Report whether a build is present, without running anything.
 *
 * @returns {{present: boolean, directory: string, binDir: string, source: 'home'|'vendor', files: string[], shared: object}} build facts.
 */
export function vendoredBuild() {
  const location = installLocation()
  const base = { directory: location.directory, binDir: location.binDir, source: location.source, shared: sharedHomeState() }
  if (!existsSync(location.binDir)) return { present: false, ...base, files: [] }
  try {
    return { present: true, ...base, files: readdirSync(location.binDir) }
  } catch {
    return { present: true, ...base, files: [] }
  }
}
