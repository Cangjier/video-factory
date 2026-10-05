/**
 * Where the shared ONNX WASM runtime is, now that it belongs to another plugin.
 *
 * This runtime used to be installed here, by `video_setup {action:"install_audio"}`, and the
 * matting model borrowed it because re-fetching 13 MB to run a second model on the same backend
 * would be absurd. Audio event detection moved to its own plugin (`dsh-video-audio`, actions
 * `audio_setup` / `audio_measure`), and the runtime went with it. Matting stayed.
 *
 * So this module answers one question — *can the matting model load, and from where* — by looking
 * in the places the runtime can now be, in order:
 *
 *   1. `DSH_AUDIO_VENDOR`, when the operator has said outright where to look;
 *   2. **the shared plugin home** (`~/.dsh-plugins/lib/onnxruntime-web`), which is where the
 *      runtime is installed now that it is shared by two models in two plugins;
 *   3. a sibling `dsh-video-audio` checkout's `vendor/audio`, the layout that existed before the
 *      shared home, so a machine that installed it then keeps working;
 *   4. this checkout's own `vendor/audio`, the oldest layout.
 *
 * Nothing is ever written to a sibling. Discovery **reports which candidate answered**, because
 * "matting works on my machine" is otherwise a fact nobody can check.
 *
 * @module video-factory/core/matte-runtime
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLUGIN_ROOT } from './env.mjs'
import { SHARED_RUNTIME_DIR } from './home.mjs'

/** Environment variable that names a shared `vendor/audio` directory outright. */
export const AUDIO_DIR_ENV = 'DSH_AUDIO_VENDOR'

/** This plugin's own `vendor/audio`: the oldest candidate, from before the runtime moved out. */
export const AUDIO_VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'audio')

/**
 * The directory holding `onnxruntime-web`, given one runtime root.
 *
 * Two layouts are in the wild and both are one line: the shared home keeps npm's own shape under
 * `lib/onnxruntime-web/node_modules/onnxruntime-web` — beside the four packages the WASM entry
 * point imports by bare specifier, which only resolve from there — while a `vendor/audio` tree
 * keeps the same shape under `runtime/`.
 *
 * @param {string} root - a runtime root: the shared `lib/onnxruntime-web`, or a `vendor/audio`.
 * @returns {string} the package directory, whether or not it exists.
 */
function packageDirIn(root) {
  return resolve(root) === resolve(SHARED_RUNTIME_DIR)
    ? join(SHARED_RUNTIME_DIR, 'node_modules', 'onnxruntime-web')
    : join(root, 'runtime', 'node_modules', 'onnxruntime-web')
}

/** The runtime entry point inside an `onnxruntime-web` package. */
const RUNTIME_ENTRY_TAIL = ['dist', 'ort.wasm.mjs']

/** The WASM binary the entry point loads. */
const RUNTIME_BINARY_TAIL = ['dist', 'ort-wasm-simd-threaded.wasm']

/** The ES module the runtime loads beside the binary. */
const RUNTIME_LOADER_TAIL = ['dist', 'ort-wasm-simd-threaded.mjs']

/**
 * Every directory that could be a runtime root, in preference order, each labelled.
 *
 * @returns {{dir: string, source: 'env'|'home'|'sibling'|'vendor'}[]} candidates, nearest first.
 */
export function audioDirCandidatesWithSource() {
  const candidates = []
  const fromEnv = process.env[AUDIO_DIR_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push({ dir: resolve(fromEnv), source: 'env' })
  candidates.push({ dir: SHARED_RUNTIME_DIR, source: 'home' })
  for (const root of [resolve(PLUGIN_ROOT, '..'), resolve(PLUGIN_ROOT, '..', '..')]) {
    // The owner of the runtime first, then this plugin's own name for the case where PLUGIN_ROOT
    // is a package directory inside a larger layout.
    candidates.push({ dir: join(root, 'dsh-video-audio', 'vendor', 'audio'), source: 'sibling' })
    candidates.push({ dir: join(root, 'video-factory', 'vendor', 'audio'), source: 'sibling' })
  }
  candidates.push({ dir: AUDIO_VENDOR_DIR, source: 'vendor' })
  return candidates
}

/**
 * Every directory that could hold the shared runtime, in preference order.
 * @returns {string[]} candidate runtime roots, nearest first.
 */
export function audioDirCandidates() {
  return audioDirCandidatesWithSource().map((candidate) => candidate.dir)
}

/**
 * Resolve the three files the WASM backend loads.
 *
 * @returns {{dir: string, source: 'env'|'home'|'sibling'|'vendor'|'missing', packageDir: string, entry: string, binary: string, loader: string}} the resolved paths; the tails are filled in even when nothing exists, so an error message can name the path that was expected.
 */
export function resolveMatteRuntime() {
  for (const candidate of audioDirCandidatesWithSource()) {
    const packageDir = packageDirIn(candidate.dir)
    const entry = join(packageDir, ...RUNTIME_ENTRY_TAIL)
    const binary = join(packageDir, ...RUNTIME_BINARY_TAIL)
    const loader = join(packageDir, ...RUNTIME_LOADER_TAIL)
    if (!existsSync(entry) || !existsSync(binary)) continue
    return { dir: candidate.dir, source: candidate.source, packageDir, entry, binary, loader }
  }
  const fallback = SHARED_LIB_DIR
  const packageDir = packageDirIn(fallback)
  return {
    dir: fallback,
    source: 'missing',
    packageDir,
    entry: join(packageDir, ...RUNTIME_ENTRY_TAIL),
    binary: join(packageDir, ...RUNTIME_BINARY_TAIL),
    loader: join(packageDir, ...RUNTIME_LOADER_TAIL),
  }
}

/** The runtime entry point, resolved. Kept as a named export because callers import it directly. */
export const ORT_WASM_ENTRY = resolveMatteRuntime().entry

/** The WASM binary, resolved. */
export const ORT_WASM_BINARY = resolveMatteRuntime().binary

/** The ES module beside the binary, resolved. */
export const ORT_WASM_LOADER = resolveMatteRuntime().loader

/**
 * The instruction to give a caller when the runtime is missing.
 *
 * It names the other plugin on purpose: the fix is not in this repository any more, and an error
 * that says "install the runtime" without saying where sends the reader hunting.
 *
 * @returns {string} a Chinese, actionable sentence.
 */
export function runtimeInstallHint() {
  return '推理运行时尚未安装：它现在由独立插件 dsh-video-audio 提供（audio_setup {action:"install"}），抠图与音频事件检测共用同一个 WASM 运行时。'
}
