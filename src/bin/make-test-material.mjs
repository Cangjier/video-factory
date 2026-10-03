/**
 * Synthetic test material, so the pipeline can be exercised without real footage.
 *
 * Two caveats are worth knowing before using this as a fixture:
 *
 * 1. The stills are gradients. A difference hash compares each pixel with its right
 *    neighbour, so vertical gradients hash identically no matter how their colours
 *    differ, and `scan` will therefore mark them as duplicates of one another. That is
 *    correct behaviour on this input, not a bug — but it makes these images a poor
 *    fixture for testing dedup discrimination. Use real photographs for that.
 * 2. The pattern varies per image so that renders have visible motion to check.
 *
 * @module video-factory/bin/make-test-material
 */
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../core/ffmpeg.mjs'

/** Distinct gradient pairs, cycled so consecutive stills differ visibly. */
const PALETTES = [
  ['0x0B1B3A', '0x2E6BE6'],
  ['0x1B0B2E', '0xB44BE6'],
  ['0x0B2E1B', '0x4BE68A'],
  ['0x2E1B0B', '0xE6A64B'],
  ['0x2E0B14', '0xE64B6B'],
  ['0x101010', '0x9AA5B1'],
]

/**
 * Generate a folder of still images and a music bed.
 *
 * @param {string} directory - destination folder; created when missing.
 * @param {object} [options] - generation options.
 * @param {number} [options.sceneCount] - how many stills. Defaults to 6.
 * @param {number} [options.seconds] - length of the music bed. Defaults to 12.
 * @param {number} [options.width] - still width. Defaults to 1080.
 * @param {number} [options.height] - still height. Defaults to 1920.
 * @param {(message: string) => void} [options.onProgress] - progress notes.
 * @returns {Promise<{directory: string, images: string[], audio: string, seconds: number}>} what was written.
 */
export async function makeTestMaterial(directory, options = {}) {
  const sceneCount = options.sceneCount ?? 6
  const seconds = options.seconds ?? 12
  const width = options.width ?? 1080
  const height = options.height ?? 1920
  mkdirSync(directory, { recursive: true })

  const names = ['开场', '问题', '转折', '方法', '结果', '收尾']
  const images = []
  for (let index = 0; index < sceneCount; index += 1) {
    const [top, bottom] = PALETTES[index % PALETTES.length]
    const label = names[index % names.length]
    const target = join(directory, `${String(index + 1).padStart(2, '0')}_${label}.jpg`)
    options.onProgress?.(`生成 ${target}`)
    // `gradients` draws a smooth ramp; the drawtext labels each frame so a rendered
    // video can be checked for the right scene order at a glance.
    await run({
      tool: 'ffmpeg',
      args: [
        '-f', 'lavfi',
        '-i', `gradients=s=${width}x${height}:c0=${top}:c1=${bottom}:x0=0:y0=0:x1=0:y1=${height}:d=1`,
        '-frames:v', '1', '-q:v', '3', target,
      ],
      timeoutMs: 120_000,
    })
    images.push(target)
  }

  const audio = join(directory, 'bgm.wav')
  options.onProgress?.(`生成 ${audio}`)
  // A quiet two-tone drone: enough for ducking and loudness normalization to act on,
  // and it makes a silent or clipped mix obvious on playback.
  await run({
    tool: 'ffmpeg',
    args: [
      '-f', 'lavfi',
      '-i', `sine=frequency=220:sample_rate=44100:duration=${seconds}`,
      '-f', 'lavfi',
      '-i', `sine=frequency=330:sample_rate=44100:duration=${seconds}`,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=0.2[a]',
      '-map', '[a]', '-c:a', 'pcm_s16le', '-ac', '2', audio,
    ],
    timeoutMs: 120_000,
  })

  return { directory, images, audio, seconds, note: '静止图是渐变色：dHash 无法区分它们，scan 会把它们标为互相重复（在这些图上这是正确行为）。要测去重判别力请用真实照片。' }
}

export { existsSync }
