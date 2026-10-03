/**
 * Delivery: the cover frame, the contact sheet, and the acceptance report.
 *
 * `verify` is what makes a delivery trustworthy. It compares the finished file with
 * the plan and returns a list of problems; an empty list is the only clean result, and
 * anything in it must be reported to the user rather than papered over.
 *
 * @module video-factory/core/deliver
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FFmpegError, run } from './ffmpeg.mjs'
import { BuildError } from './scene.mjs'
import { estimatedDuration } from './plan.mjs'
import { probe } from './probe.mjs'

/**
 * Floor on how many bits a rendered pixel-second can plausibly occupy.
 *
 * A flat absolute byte threshold cannot work here. The value this replaces was 10 000 bytes,
 * tuned against a 1080x1920 gradient demo that lands near 2 MB; a legitimate 640x360 clip of two
 * seconds over a flat background encodes to 7.7 KB and was reported as a failed render. A static,
 * low-complexity picture is exactly what a matted scene produces, so that false positive fired on
 * this feature's own output.
 *
 * Bytes scale with pixels, seconds, and content complexity, so the floor is expressed the same
 * way: a very low bitrate per megapixel-second. 0.01 bits per pixel-second is orders of magnitude
 * below what real footage costs, so the check catches an empty or nearly-empty stream without
 * pretending to judge compression.
 */
export const MIN_BITS_PER_PIXEL_SECOND = 0.01

/** Absolute floor, for a stream that is valid but trivially short. */
export const MIN_PLAUSIBLE_BYTES = 1_000

/**
 * Compare a finished file with the plan it came from.
 *
 * The duration tolerance is deliberately loose: container and encoder rounding move
 * the real length by a few tens of milliseconds, and the plan's own estimate already
 * accounts for transition overlap rather than exact frame counts.
 *
 * @param {object} info - probed info for the finished file.
 * @param {object} plan - the plan it was rendered from.
 * @returns {string[]} human-readable problems; empty means the file matches the plan.
 */
export function verifyAgainstPlan(info, plan) {
  const problems = []
  if (info.width !== plan.width || info.height !== plan.height) {
    problems.push(`分辨率是 ${info.width}x${info.height}，计划要求 ${plan.width}x${plan.height}`)
  }
  if (Math.abs(info.fps - plan.fps) > 0.5) {
    problems.push(`帧率是 ${info.fps.toFixed(2)}，计划要求 ${plan.fps.toFixed(2)}`)
  }
  const expected = estimatedDuration(plan.scenes)
  const tolerance = Math.max(1, expected * 0.06)
  if (Math.abs(info.duration - expected) > tolerance) {
    problems.push(`时长是 ${info.duration.toFixed(2)}s，计划估算 ${expected.toFixed(2)}s`)
  }
  if (!info.hasAudio) problems.push('成片没有音轨')
  if (info.pixFmt !== 'yuv420p') problems.push(`像素格式是 ${info.pixFmt}，多数平台要求 yuv420p`)
  // Scale the floor with the picture: a flat 10 KB threshold fails a legitimate short clip of
  // simple content, which is precisely what a matted or solid-colour scene produces.
  const pixels = Math.max(1, info.width * info.height)
  const seconds = Math.max(0.1, info.duration)
  const floorBytes = Math.max(
    MIN_PLAUSIBLE_BYTES,
    Math.round((pixels * seconds * MIN_BITS_PER_PIXEL_SECOND) / 8),
  )
  if (info.sizeBytes < floorBytes) {
    problems.push(
      `文件过小（${info.sizeBytes} 字节，${info.width}x${info.height} ${info.duration.toFixed(2)}s 的合理下限是 ${floorBytes} 字节），可能渲染失败`,
    )
  }
  return problems
}

/**
 * Write the cover frame, the contact sheet, and the build report.
 *
 * @param {string} finalPath - the finished video.
 * @param {object} plan - the plan it came from.
 * @param {object} options - delivery options.
 * @param {string} options.outDir - destination directory.
 * @param {Array<{name: string, seconds: number, detail: string, outputs: string[]}>} [options.stages] - stage log.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(line: string) => void} [options.onProgress] - ffmpeg progress lines.
 * @returns {Promise<object>} the delivery report, including a `problems` array.
 * @throws {BuildError} when the video is missing or a frame cannot be extracted.
 */
export async function deliver(finalPath, plan, options) {
  const outDir = options.outDir
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(finalPath)) throw new BuildError(`找不到成片：${finalPath}`)

  const started = Date.now()
  const info = await probe(finalPath, options.config ?? {})
  const cover = join(outDir, 'cover.jpg')
  const sheet = join(outDir, 'contact-sheet.jpg')
  const config = options.config ?? {}
  const onStderr = options.onProgress

  // A frame from about a quarter in is more representative than the very first one,
  // which is often a fade-in from black.
  const coverAt = Math.min(1, info.duration / 4)
  try {
    await run({
      tool: 'ffmpeg',
      args: ['-ss', coverAt.toFixed(3), '-i', finalPath, '-frames:v', '1', '-update', '1', '-q:v', '2', cover],
      config,
      timeoutMs: 5 * 60 * 1000,
      onStderr,
    })
  } catch (error) {
    throw new BuildError(`封面帧提取失败。\n${error instanceof FFmpegError ? error.message : String(error)}`)
  }

  const columns = Math.min(5, Math.max(1, plan.scenes.length))
  const rows = Math.max(1, Math.ceil(plan.scenes.length / columns))
  const interval = Math.max(info.duration / (columns * rows), 0.2)
  try {
    await run({
      tool: 'ffmpeg',
      args: [
        '-i', finalPath,
        '-vf', `fps=1/${interval.toFixed(3)},scale=320:-2,tile=${columns}x${rows}`,
        '-frames:v', '1', '-update', '1', '-q:v', '3', sheet,
      ],
      config,
      timeoutMs: 10 * 60 * 1000,
      onStderr,
    })
  } catch (error) {
    throw new BuildError(`缩略图总览生成失败。\n${error instanceof FFmpegError ? error.message : String(error)}`)
  }

  const problems = verifyAgainstPlan(info, plan)
  const stages = [...(options.stages ?? [])]
  stages.push({
    name: 'deliver',
    seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    detail: '封面与缩略图',
    outputs: [cover, sheet],
  })

  const report = {
    output: finalPath,
    cover,
    contactSheet: sheet,
    video: {
      width: info.width,
      height: info.height,
      fps: info.fps,
      duration: info.duration,
      pixFmt: info.pixFmt,
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
      hasAudio: info.hasAudio,
      sizeBytes: info.sizeBytes,
      bitRate: info.bitRate,
    },
    preset: plan.preset,
    quality: plan.quality,
    sceneCount: plan.scenes.length,
    plannedDuration: Number(estimatedDuration(plan.scenes).toFixed(3)),
    title: plan.title,
    stages,
    problems,
  }

  writeFileSync(join(outDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' })
  return report
}

/**
 * Extract a single frame from a video at a given time.
 * @param {string} source - the video.
 * @param {string} target - destination image path.
 * @param {object} options - extraction options.
 * @param {number} [options.at] - seconds into the video. Defaults to 1, or a quarter in.
 * @param {object} [options.config] - normalized plugin config.
 * @returns {Promise<string>} the written path.
 */
export async function extractFrame(source, target, options = {}) {
  const info = await probe(source, options.config ?? {})
  const at = options.at ?? Math.min(1, info.duration / 4)
  await run({
    tool: 'ffmpeg',
    args: ['-ss', at.toFixed(3), '-i', source, '-frames:v', '1', '-update', '1', '-q:v', '2', target],
    config: options.config ?? {},
    timeoutMs: 5 * 60 * 1000,
  })
  return target
}
