/**
 * Provisioning the matting model.
 *
 * One file, 4.36 MB, pinned by SHA-256 — the same shape as the other two installers. The
 * inference runtime is deliberately **not** re-fetched here. It used to be vendored by
 * `install_audio`, which lived in this plugin; both that action and the runtime moved to the
 * separate `dsh-video-audio` plugin (see {@link module:video-factory/core/matte-runtime}). Matting
 * still shares it rather than duplicating 13 MB, so `matteState` and this installer both report a
 * missing runtime by naming the plugin that owns it — and refuse before downloading a model that
 * could not then be loaded.
 *
 * The provenance chain is a single personal re-upload of an Apache-2.0 model, so the recorded
 * hash is a tamper-detection and reproducibility anchor, exactly as with YAMNet — not evidence
 * that the weights are authentic.
 *
 * @module video-factory/core/matte-install
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { download } from './install.mjs'
import { runtimeInstallHint } from './matte-runtime.mjs'
import {
  MATTE_MODEL,
  MATTE_MODEL_SPEC,
  MATTE_VENDOR_DIR,
  MatteError,
  matteState,
} from './matte.mjs'

/** Scratch directory for the download. */
export const MATTE_SCRATCH_DIR = join(MATTE_VENDOR_DIR, '.download')

/** The manifest recording what was installed and from where. */
export const MATTE_MANIFEST = join(MATTE_VENDOR_DIR, 'SOURCE.json')

/**
 * SHA-256 of a file.
 * @param {string} path - the file.
 * @returns {string} lowercase hex digest.
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Describe what is installed, reading the disk rather than the manifest.
 * @returns {object} the state, with the manifest's claims alongside.
 */
export function matteInstallState() {
  const state = matteState()
  let manifest = null
  if (existsSync(MATTE_MANIFEST)) {
    try {
      manifest = JSON.parse(readFileSync(MATTE_MANIFEST, 'utf8'))
    } catch {
      manifest = null
    }
  }
  return {
    ...state,
    manifest,
    installedBytes: state.model ? statSync(MATTE_MODEL).size : 0,
  }
}

/**
 * Verify the installed model against its pin.
 * @returns {{checked: number, ok: boolean, expected: string, actual: string|null}} the verdict.
 */
export function verifyInstalledMatte() {
  if (!existsSync(MATTE_MODEL)) {
    return { checked: 0, ok: false, expected: MATTE_MODEL_SPEC.sha256, actual: null }
  }
  const actual = sha256File(MATTE_MODEL)
  return { checked: 1, ok: actual === MATTE_MODEL_SPEC.sha256, expected: MATTE_MODEL_SPEC.sha256, actual }
}

/**
 * Write the provenance manifest for the model on disk.
 * @returns {object} the manifest that was written.
 */
export function writeMatteManifest() {
  const manifest = {
    model: { ...MATTE_MODEL_SPEC },
    files: existsSync(MATTE_MODEL)
      ? [{ path: 'u2netp.onnx', bytes: statSync(MATTE_MODEL).size, sha256: sha256File(MATTE_MODEL) }]
      : [],
    runtime: {
      shared: true,
      note:
        '推理运行时由独立插件 dsh-video-audio 提供（它自己的 vendor/audio/runtime，' +
        '旧机器上可能还在本仓库的 vendor/audio/runtime），抠图与音频事件检测共用，不重复下载。',
    },
    recordedAt: new Date().toISOString(),
  }
  mkdirSync(MATTE_VENDOR_DIR, { recursive: true })
  writeFileSync(MATTE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/**
 * Install the matting model.
 *
 * Idempotent, and safe against a partial download: the file lands in the scratch directory, is
 * hashed there, and only replaces the model once it matches. `modelArchive` points at a
 * locally-supplied copy for when the host is unreachable, and the hash is checked either way.
 *
 * @param {object} [options] - `{ force, modelArchive, onProgress }`.
 * @returns {Promise<object>} `{ installed, skipped, verify, state }`.
 * @throws {MatteError} when the pin is malformed, the runtime is missing, or a download fails.
 */
export async function installMatte(options = {}) {
  const onProgress = options.onProgress ?? (() => {})
  const force = options.force === true

  if (!/^[0-9a-f]{64}$/.test(MATTE_MODEL_SPEC.sha256 ?? '')) {
    // Refuse before spending a download on something that could not be trusted. Skipping the
    // comparison because the pin looks odd would turn a typo into an unverified install.
    throw new MatteError(
      `u2netp 的 sha256 不是 64 位小写十六进制（收到 ${JSON.stringify(MATTE_MODEL_SPEC.sha256)}）；拒绝安装。`,
    )
  }

  if (!force) {
    const current = verifyInstalledMatte()
    // The runtime is a hard prerequisite, so it is part of the skip test. Testing only the model
    // would download 4.36 MB here and *then* say the runtime is missing — paying for a model that
    // cannot load. A missing runtime fails before the download instead.
    const state = matteState()
    if (current.ok && state.runtime) {
      onProgress('抠图模型已安装且校验通过，跳过下载。')
      return { installed: false, skipped: true, verify: current, state }
    }
    if (!state.runtime) {
      throw new MatteError(
        `${runtimeInstallHint()}（当前 ${state.runtimeDir} 里没有 onnxruntime-web。）` +
          '先装运行时再装模型，否则这 4.36 MB 白下。',
      )
    }
  }

  const local = typeof options.modelArchive === 'string' && options.modelArchive !== ''
    ? resolve(options.modelArchive)
    : null
  if (local !== null && !existsSync(local)) throw new MatteError(`modelArchive 指向的文件不存在：${local}`)

  mkdirSync(MATTE_SCRATCH_DIR, { recursive: true })
  const staged = join(MATTE_SCRATCH_DIR, 'u2netp.onnx')
  rmSync(staged, { force: true })

  try {
    if (local !== null) {
      onProgress(`使用本地模型包 ${local}`)
      copyFileSync(local, staged)
    } else {
      onProgress('下载 u2netp.onnx …')
      await download(MATTE_MODEL_SPEC.url, staged, (bytes) => onProgress(`  u2netp.onnx ${(bytes / 1024 / 1024).toFixed(2)} MB`))
    }

    const actual = sha256File(staged)
    if (actual !== MATTE_MODEL_SPEC.sha256) {
      throw new MatteError(
        `u2netp.onnx 的 sha256 不匹配，已中止。\n  期望 ${MATTE_MODEL_SPEC.sha256}\n  实得 ${actual}\n` +
          '下载可能被中断或被篡改；请重试，不要使用这个文件。',
      )
    }

    mkdirSync(MATTE_VENDOR_DIR, { recursive: true })
    writeFileSync(MATTE_MODEL, readFileSync(staged))
    onProgress(`  u2netp.onnx 校验通过（${(statSync(MATTE_MODEL).size / 1024 / 1024).toFixed(2)} MB）`)
  } finally {
    // Whether it matched, failed the hash, or the network died mid-stream, a partial file must
    // not survive: a stale one would be silently reused as the next attempt's target.
    rmSync(staged, { force: true })
  }

  const manifest = writeMatteManifest()
  const verify = verifyInstalledMatte()
  const state = matteState()

  if (state.runtime === false) {
    onProgress(`模型已就位，但推理运行时缺失。${runtimeInstallHint()}`)
  } else {
    onProgress(`完成：${(manifest.files[0]?.bytes / 1024 / 1024).toFixed(2)} MB（运行时共用，不重复下载）`)
  }

  return { installed: true, skipped: false, verify, state, manifest }
}

/**
 * Remove the vendored matting model.
 *
 * Only this model is removed. The shared WASM runtime under `vendor/audio` belongs to
 * `install_audio` and is left alone, because deleting it here would silently break audio event
 * detection as a side effect of removing a matting model.
 *
 * @param {{onProgress?: (line: string) => void}} [options] - progress callback.
 * @returns {{removed: boolean, directory: string, keptRuntime: boolean}} the outcome.
 */
export function removeMatte(options = {}) {
  const onProgress = options.onProgress ?? (() => {})
  if (!existsSync(MATTE_VENDOR_DIR)) {
    onProgress('没有已安装的抠图模型可供删除。')
    return { removed: false, directory: MATTE_VENDOR_DIR, keptRuntime: true }
  }
  rmSync(MATTE_VENDOR_DIR, { recursive: true, force: true })
  onProgress(`已删除 ${MATTE_VENDOR_DIR}（vendor/audio 的共享运行时保留，音频事件检测不受影响）`)
  return { removed: true, directory: MATTE_VENDOR_DIR, keptRuntime: true }
}
