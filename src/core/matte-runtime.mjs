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
 *   2. this checkout's `vendor/audio` — still valid, and still what a machine that installed the
 *      runtime before the split has;
 *   3. a sibling `dsh-video-audio` checkout's `vendor/audio`, which is the new normal;
 *   4. a sibling `video-factory` checkout's, for a `link:` install whose real path points into a
 *      package directory.
 *
 * Nothing is ever written to a sibling. Discovery **reports which candidate answered**, because
 * "matting works on my machine" is otherwise a fact nobody can check.
 *
 * @module video-factory/core/matte-runtime
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLUGIN_ROOT } from './env.mjs'

/** Environment variable that names the shared runtime's `vendor/audio` directory outright. */
export const AUDIO_DIR_ENV = 'DSH_AUDIO_VENDOR'

/** The runtime entry point inside a `vendor/audio` tree. */
const RUNTIME_ENTRY_TAIL = ['runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort.wasm.mjs']

/** The WASM binary the entry point loads. */
const RUNTIME_BINARY_TAIL = ['runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm']

/** The ES module the runtime loads beside the binary. */
const RUNTIME_LOADER_TAIL = [
  'runtime',
  'node_modules',
  'onnxruntime-web',
  'dist',
  'ort-wasm-simd-threaded.mjs',
]

/** This plugin's own `vendor/audio`: the first candidate, and the one that existed before the split. */
export const AUDIO_VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'audio')

/**
 * Every directory that could hold the shared runtime, in preference order.
 *
 * @returns {string[]} candidate `vendor/audio` directories, nearest first.
 */
export function audioDirCandidates() {
  const candidates = []
  const fromEnv = process.env[AUDIO_DIR_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(resolve(fromEnv))
  candidates.push(AUDIO_VENDOR_DIR)
  for (const root of [resolve(PLUGIN_ROOT, '..'), resolve(PLUGIN_ROOT, '..', '..')]) {
    // The new owner first, then this plugin's own name for the case where PLUGIN_ROOT is a
    // package directory inside a larger layout.
    candidates.push(join(root, 'dsh-video-audio', 'vendor', 'audio'))
    candidates.push(join(root, 'video-factory', 'vendor', 'audio'))
  }
  return candidates
}

/**
 * Resolve the three files the WASM backend loads.
 *
 * @returns {{dir: string, source: 'env'|'vendor'|'sibling'|'missing', entry: string, binary: string, loader: string}} the resolved paths; the tails are filled in even when nothing exists, so an error message can name the path that was expected.
 */
export function resolveMatteRuntime() {
  for (const [index, directory] of audioDirCandidates().entries()) {
    const entry = join(directory, ...RUNTIME_ENTRY_TAIL)
    const binary = join(directory, ...RUNTIME_BINARY_TAIL)
    const loader = join(directory, ...RUNTIME_LOADER_TAIL)
    if (!existsSync(entry) || !existsSync(binary)) continue
    const source =
      index === 0 && directory !== AUDIO_VENDOR_DIR ? 'env' : directory === AUDIO_VENDOR_DIR ? 'vendor' : 'sibling'
    return { dir: directory, source, entry, binary, loader }
  }
  const fallback = audioDirCandidates()[1] ?? AUDIO_VENDOR_DIR
  return {
    dir: fallback,
    source: 'missing',
    entry: join(fallback, ...RUNTIME_ENTRY_TAIL),
    binary: join(fallback, ...RUNTIME_BINARY_TAIL),
    loader: join(fallback, ...RUNTIME_LOADER_TAIL),
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
