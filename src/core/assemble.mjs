/**
 * Joining normalized clips into one timeline.
 *
 * Two paths, chosen by whether the plan asks for transitions. With hard cuts
 * everywhere, the concat demuxer copies streams — fast and lossless, and only safe
 * because {@link module:video-factory/core/scene} already made every clip uniform. With
 * transitions, a single filter graph chains `xfade` and `acrossfade` at computed
 * offsets, which necessarily re-encodes but does so once for the whole timeline.
 *
 * @module video-factory/core/assemble
 */
import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FFmpegError, run } from './ffmpeg.mjs'
import { MEZZANINE_CRF, BuildError } from './scene.mjs'
import { effectiveOverlap, transitionOffsets } from './plan.mjs'

/**
 * The assembled timeline path for a working directory.
 * @param {string} workDir - the working directory.
 * @returns {string} the absolute path of `timeline.mp4`.
 */
export function timelinePath(workDir) {
  return join(workDir, 'timeline.mp4')
}

/**
 * Join normalized clips, applying transitions when the plan asks for them.
 *
 * @param {string[]} clips - normalized clip paths, in plan order.
 * @param {object} plan - the enclosing plan, supplying scenes and fps.
 * @param {object} options - assembly options.
 * @param {string} options.workDir - the working directory.
 * @param {boolean} [options.force] - rebuild even when the timeline exists.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(line: string) => void} [options.onProgress] - ffmpeg progress lines.
 * @returns {Promise<{path: string, reused: boolean, detail: string, seconds: number}>} the outcome.
 * @throws {BuildError} when clips are missing or assembly fails.
 */
export async function assemble(clips, plan, options) {
  const workDir = options.workDir
  const target = timelinePath(workDir)
  const started = Date.now()

  if (!options.force && existsSync(target) && statSync(target).size > 0) {
    return { path: target, reused: true, detail: '复用缓存', seconds: 0 }
  }
  if (clips.length === 0) throw new BuildError('没有可拼接的片段')
  for (const clip of clips) {
    if (!existsSync(clip)) throw new BuildError(`拼接所需片段不存在：${clip}`)
  }

  if (clips.length === 1) {
    copyFileSync(clips[0], target)
    return { path: target, reused: false, detail: '单镜头', seconds: (Date.now() - started) / 1000 }
  }

  const offsets = transitionOffsets(plan.scenes)
  const hasTransition = offsets.some((offset) => offset >= 0)

  if (!hasTransition) {
    const listing = join(workDir, 'concat.txt')
    // The concat demuxer needs forward slashes and no byte-order mark.
    writeFileSync(
      listing,
      clips.map((clip) => `file '${clip.replace(/\\/g, '/')}'\n`).join(''),
      { encoding: 'utf8' },
    )
    try {
      await run({
        tool: 'ffmpeg',
        args: ['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', target],
        cwd: workDir,
        config: options.config ?? {},
        timeoutMs: 30 * 60 * 1000,
        onStderr: options.onProgress,
      })
    } catch (error) {
      throw new BuildError(`流复制拼接失败。\n${error instanceof FFmpegError ? error.message : String(error)}`)
    }
    return {
      path: target,
      reused: false,
      detail: '无转场，流复制拼接',
      seconds: (Date.now() - started) / 1000,
    }
  }

  const args = []
  for (const clip of clips) args.push('-i', clip)

  const parts = []
  for (let index = 0; index < clips.length; index += 1) {
    // xfade requires every input on a common time base with timestamps from zero.
    parts.push(`[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[sv${index}]`)
    parts.push(`[${index}:a]asetpts=PTS-STARTPTS[sa${index}]`)
  }

  let videoLabel = 'sv0'
  let audioLabel = 'sa0'
  for (let index = 1; index < clips.length; index += 1) {
    const transition = plan.scenes[index].transition
    const outVideo = `vx${index}`
    const outAudio = `ax${index}`
    if (offsets[index - 1] < 0) {
      parts.push(`[${videoLabel}][sv${index}]concat=n=2:v=1:a=0[${outVideo}]`)
      parts.push(`[${audioLabel}][sa${index}]concat=n=2:v=0:a=1[${outAudio}]`)
    } else {
      const overlap = effectiveOverlap(plan.scenes, index)
      parts.push(
        `[${videoLabel}][sv${index}]xfade=transition=${transition.type}` +
          `:duration=${overlap.toFixed(3)}:offset=${offsets[index - 1].toFixed(3)}[${outVideo}]`,
      )
      parts.push(`[${audioLabel}][sa${index}]acrossfade=d=${overlap.toFixed(3)}:c1=tri:c2=tri[${outAudio}]`)
    }
    videoLabel = outVideo
    audioLabel = outAudio
  }

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', `[${videoLabel}]`, '-map', `[${audioLabel}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(MEZZANINE_CRF),
    '-pix_fmt', 'yuv420p', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '90000', '-movflags', '+faststart', target,
  )

  try {
    await run({
      tool: 'ffmpeg',
      args,
      cwd: workDir,
      config: options.config ?? {},
      timeoutMs: 60 * 60 * 1000,
      onStderr: options.onProgress,
    })
  } catch (error) {
    throw new BuildError(`转场拼接失败。\n${error instanceof FFmpegError ? error.message : String(error)}`)
  }

  return {
    path: target,
    reused: false,
    detail: `${clips.length} 个镜头带转场`,
    seconds: (Date.now() - started) / 1000,
  }
}
