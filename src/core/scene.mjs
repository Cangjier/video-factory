/**
 * Normalizing one scene into a uniform intermediate clip.
 *
 * This is the pivot of the whole pipeline. A finished video is assembled from clips
 * that all share a canvas size, frame rate, pixel format, time base, and — crucially —
 * an audio track whose length equals the scene's duration exactly. When that
 * uniformity holds, joining clips is safe, because the concat demuxer silently
 * produces frozen frames, drifting audio, and players that stop at the seam when any
 * of those differ. It does not report an error, which is why the uniformity is
 * enforced here rather than hoped for.
 *
 * Two Windows facts shape this module:
 *   - The bundled ffmpeg has no fontconfig, so a CJK font is copied into the working
 *     directory under an ASCII name and referenced relatively.
 *   - Overlay text is written to a BOM-free UTF-8 file and passed via `textfile=`,
 *     which keeps Chinese out of the graph and keeps the drive-letter colon out too.
 *
 * @module video-factory/core/scene
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { FFmpegError, run } from './ffmpeg.mjs'
import { applyOverlays, atempoChain, fitFilters, motionFilters, toFfmpegColor } from './filter.mjs'
import { probe } from './probe.mjs'
import { fontDirectories } from './env.mjs'

/** Intermediate clips are near-lossless; the final pass sets the delivered quality. */
export const MEZZANINE_CRF = 16

/** CJK-capable fonts, in preference order. */
export const FONT_CANDIDATES = ['msyh.ttc', 'msyhbd.ttc', 'simhei.ttf', 'simsun.ttc', 'Deng.ttf']

/** Longest intermediate path this builder will construct, well under the Windows limit. */
export const MAX_INTERMEDIATE_PATH = 200

/** Raised when a scene cannot be rendered. */
export class BuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BuildError'
  }
}

/**
 * Locate a CJK-capable font on this machine.
 * @param {boolean} [bold] - prefer a bold face.
 * @returns {string|null} the font path, or null when none exists.
 */
export function findCjkFont(bold = false) {
  const order = bold ? ['msyhbd.ttc', 'msyh.ttc', 'simhei.ttf', 'simsun.ttc', 'Deng.ttf'] : FONT_CANDIDATES
  for (const directory of fontDirectories()) {
    for (const name of order) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Copy a CJK font into the working directory under an ASCII name.
 *
 * libass is told to scan this directory, and `drawtext` gets an explicit file, which
 * between them avoid the missing fontconfig and the drive-letter escaping problem.
 * @param {string} workDir - the working directory.
 * @returns {string|null} the font path relative to the working directory, or null.
 */
export function stageFont(workDir) {
  const source = findCjkFont()
  if (source === null) return null
  const fontDir = join(workDir, 'fonts')
  mkdirSync(fontDir, { recursive: true })
  const staged = join(fontDir, 'cjk.ttc')
  if (!existsSync(staged) || statSync(staged).size !== statSync(source).size) {
    copyFileSync(source, staged)
  }
  return 'fonts/cjk.ttc'
}

/**
 * Fail early when the working directory is deep enough to hit the path limit.
 *
 * The Windows limit is not always enabled, and when it bites the error is a deeply
 * confusing "no such file or directory", so the budget is checked up front.
 * @param {string} workDir - the working directory.
 * @param {number} sceneCount - how many scenes are planned.
 * @param {number} budget - the longest permitted intermediate path.
 * @throws {BuildError} when a planned intermediate path would exceed the budget.
 */
export function checkPathBudget(workDir, sceneCount, budget = MAX_INTERMEDIATE_PATH) {
  const probePath = join(workDir, 'scenes', `${String(sceneCount).padStart(3, '0')}_scene.mp4`)
  if (probePath.length > budget) {
    throw new BuildError(
      `工作目录太深，中间产物路径会超过 Windows 路径限制（${probePath.length} > ${budget} 字符）：${workDir}。` +
        '请换一个更浅的输出目录。',
    )
  }
}

/**
 * Write overlay text to a BOM-free UTF-8 file and return its filename.
 *
 * A byte-order mark renders as a stray glyph in `drawtext`, so the file is written
 * with an explicit newline and no preamble.
 * @param {string} workDir - the working directory.
 * @param {string} sceneId - the scene the overlay belongs to.
 * @param {number} index - the overlay's position within the scene.
 * @param {string} text - the literal text.
 * @returns {string} the staged filename, relative to the working directory.
 */
export function stageOverlayText(workDir, sceneId, index, text) {
  const name = `ov_${sceneId}_${index}.txt`
  writeFileSync(join(workDir, name), String(text).replace(/\r\n/g, '\n'), { encoding: 'utf8' })
  return name
}

/**
 * Build the input arguments, filter chains, and trailing options for one scene.
 *
 * @param {object} scene - a validated scene.
 * @param {object} plan - the enclosing plan, supplying canvas and fps.
 * @param {object} options - construction options.
 * @param {string} options.workDir - the working directory.
 * @param {string|null} options.fontFile - staged font path relative to the working directory.
 * @param {object} [options.config] - normalized plugin config.
 * @param {object|null} [options.info] - pre-probed source info, to avoid a second probe.
 * @returns {Promise<{inputs: string[], video: string, audio: string, tail: string[]}>} the pieces.
 * @throws {BuildError} when the source is missing.
 */
export async function sceneArguments(scene, plan, options) {
  const width = plan.width
  const height = plan.height
  const fps = plan.fps
  const duration = scene.duration
  const frames = Math.max(1, Math.round(duration * fps))
  const tail = ['-t', duration.toFixed(3), '-fps_mode', 'cfr']
  const overlayContext = {
    sceneDuration: duration,
    canvasWidth: width,
    fontFile: options.fontFile,
    textFileFor: (overlay, index) => stageOverlayText(options.workDir, scene.id, index, overlay.text),
  }

  if (scene.kind === 'color') {
    // Overlays apply here too: a solid colour with a title on it is one of the most
    // common shots in a scripted video, and omitting the drawtext pass would render it
    // silently bare.
    const chain = `fps=${fps.toFixed(6)},format=yuv420p`
    return {
      inputs: ['-f', 'lavfi', '-i', `color=c=${toFfmpegColor(scene.color)}:s=${width}x${height}:r=${fps.toFixed(6)}`],
      video: `[0:v]${applyOverlays(chain, scene.overlays, overlayContext)}[v]`,
      audio: `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${duration.toFixed(3)}[a]`,
      tail,
    }
  }

  const source = resolve(scene.resolved ?? scene.source ?? '')
  if (!existsSync(source)) {
    throw new BuildError(`镜头 ${scene.id}：找不到素材 ${source}`)
  }

  if (scene.kind === 'image') {
    // `-t` before `-i` bounds the looped still to exactly the scene length, which is
    // what makes `zoompan=d=1` emit one output frame per input frame.
    const inputs = ['-loop', '1', '-framerate', fps.toFixed(6), '-t', duration.toFixed(3), '-i', source]
    const chain =
      scene.motion === 'none'
        ? fitFilters(scene.fit, width, height, scene.id)
        : motionFilters(scene.motion, frames, width, height, fps)
    const full =
      chain +
      `,setsar=1,fps=${fps.toFixed(6)},trim=duration=${duration.toFixed(3)},` +
      'setpts=PTS-STARTPTS,setrange=tv,format=yuv420p'
    return {
      inputs,
      video: `[0:v]${applyOverlays(full, scene.overlays, overlayContext)}[v]`,
      audio: `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${duration.toFixed(3)}[a]`,
      tail,
    }
  }

  // Video source.
  const info = options.info ?? (await probe(source, options.config ?? {}))
  const sourceDuration = info.duration
  const needed = duration * scene.speed
  // `-stream_loop -1` repeats a clip shorter than its slot instead of freezing on the
  // final frame.
  const inputs = ['-stream_loop', '-1', '-i', source]
  let start = scene.start
  if (sourceDuration > 0) start = Math.min(scene.start, Math.max(sourceDuration - 0.05, 0))

  const speedFilter = Math.abs(scene.speed - 1) > 1e-9 ? `/${scene.speed.toFixed(6)}` : ''
  let chain = `trim=start=${start.toFixed(3)}:duration=${needed.toFixed(3)},setpts=(PTS-STARTPTS)${speedFilter}`
  chain += `,${fitFilters(scene.fit, width, height, scene.id)}`
  chain +=
    `,setsar=1,fps=${fps.toFixed(6)},trim=duration=${duration.toFixed(3)},` +
    'setpts=PTS-STARTPTS,setrange=tv,format=yuv420p'
  const video = `[0:v]${applyOverlays(chain, scene.overlays, overlayContext)}[v]`

  let audio
  if (scene.muted || !info.hasAudio) {
    audio = `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${duration.toFixed(3)}[a]`
  } else {
    const tempo = atempoChain(scene.speed)
    let audioChain = `atrim=start=${start.toFixed(3)}:duration=${needed.toFixed(3)},asetpts=PTS-STARTPTS`
    if (tempo !== '') audioChain += `,${tempo}`
    if (Math.abs(scene.volume - 1) > 1e-9) audioChain += `,volume=${scene.volume.toFixed(4)}`
    // `apad` fills clips whose audio is shorter than the picture; the output `-t`
    // then trims the padded result back to exactly the scene duration.
    audioChain += ',aresample=48000:async=1:first_pts=0,apad'
    audio = `[0:a]${audioChain}[a]`
  }

  return { inputs, video, audio, tail }
}

/**
 * The intermediate clip path for one scene.
 * @param {string} workDir - the working directory.
 * @param {number} index - the scene's position in the plan.
 * @param {string} sceneId - the scene id.
 * @returns {string} the absolute clip path.
 */
export function clipPath(workDir, index, sceneId) {
  return join(workDir, 'scenes', `${String(index).padStart(3, '0')}_${sceneId}.mp4`)
}

/**
 * Render one scene to a uniform intermediate clip.
 *
 * The clip is reused when it already exists, so a re-run after editing one scene only
 * re-encodes that scene. Pass `force` to redo it regardless.
 *
 * @param {object} scene - a validated scene.
 * @param {object} plan - the enclosing plan.
 * @param {number} index - the scene's position, used for the file name.
 * @param {object} options - render options.
 * @param {string} options.workDir - the working directory; created when missing.
 * @param {boolean} [options.force] - re-encode even when the clip exists.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(line: string) => void} [options.onProgress] - ffmpeg progress lines.
 * @returns {Promise<{path: string, reused: boolean, seconds: number}>} the outcome.
 * @throws {BuildError} when the scene fails to render.
 */
export async function renderScene(scene, plan, index, options) {
  const workDir = options.workDir
  mkdirSync(join(workDir, 'scenes'), { recursive: true })
  checkPathBudget(workDir, plan.scenes.length, options.pathBudget)

  const target = clipPath(workDir, index, scene.id)
  if (!options.force && existsSync(target) && statSync(target).size > 0) {
    return { path: target, reused: true, seconds: 0 }
  }

  const fontFile = stageFont(workDir)
  const started = Date.now()
  const { inputs, video, audio, tail } = await sceneArguments(scene, plan, {
    workDir,
    fontFile,
    config: options.config,
  })

  const keyframe = Math.max(1, Math.round(plan.fps * 2))
  const args = [
    ...inputs,
    '-filter_complex', `${video};${audio}`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(MEZZANINE_CRF),
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-profile:v', 'high',
    '-g', String(keyframe), '-keyint_min', String(keyframe), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '90000',
    ...tail,
    target,
  ]

  try {
    await run({
      tool: 'ffmpeg',
      args,
      cwd: workDir,
      config: options.config ?? {},
      timeoutMs: 30 * 60 * 1000,
      onStderr: options.onProgress,
    })
  } catch (error) {
    if (error instanceof FFmpegError) {
      throw new BuildError(`镜头 ${scene.id} 渲染失败。\n${error.message}`)
    }
    throw error
  }

  if (!existsSync(target) || statSync(target).size === 0) {
    throw new BuildError(`镜头 ${scene.id} 渲染后没有产出文件：${target}`)
  }
  return { path: target, reused: false, seconds: (Date.now() - started) / 1000 }
}

export { basename }
