/**
 * Material inventory: what is in a folder, and which stills look the same.
 *
 * `scan` describes and never decides. Near-duplicate stills are *marked*, not
 * dropped, and nothing is reordered into a "suggested" sequence: choosing what to
 * use is the creative work that belongs to DSH.
 *
 * Perceptual hashing normally needs an image decoder. Rather than take a
 * dependency, this asks the ffmpeg that is already required for everything else to
 * scale each still down to 9x8 raw greyscale, which is exactly the input a
 * difference hash needs.
 *
 * @module video-factory/core/materials
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { run } from './ffmpeg.mjs'
import { classify, probe, streamProblems } from './probe.mjs'

/** Files that are noise rather than material. */
export const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

/** Hamming distance at or below which two dHashes count as the same picture. */
export const DUPLICATE_DISTANCE = 6

/** Raised when a material folder cannot be inventoried. */
export class MaterialError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MaterialError'
  }
}

/**
 * Compute a 64-bit difference hash for a still image.
 *
 * The image is scaled to 9x8 greyscale and each pixel is compared with its right
 * neighbour, giving 8 comparisons per row across 8 rows. This survives re-encoding,
 * resizing, and mild colour shifts, which is what "the same picture" means here.
 *
 * @param {string} path - the image file.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<bigint|null>} the hash, or null when the image cannot be read.
 */
export async function differenceHash(path, config = {}) {
  try {
    const result = await run({
      tool: 'ffmpeg',
      args: [
        '-v', 'error',
        '-i', path,
        '-vf', 'scale=9:8:flags=area,format=gray',
        '-frames:v', '1',
        '-f', 'rawvideo',
        '-',
      ],
      config,
      timeoutMs: 30_000,
      // The output is raw pixel bytes; a utf8 decode would corrupt everything above 0x7f.
      stdoutEncoding: 'binary',
    })
    const bytes = Buffer.from(result.stdout, 'binary')
    if (bytes.length < 72) return null

    let hash = 0n
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const left = bytes[row * 9 + column]
        const right = bytes[row * 9 + column + 1]
        hash = (hash << 1n) | (left > right ? 1n : 0n)
      }
    }
    return hash
  } catch {
    return null
  }
}

/**
 * Count differing bits between two 64-bit hashes.
 * @param {bigint} left - first hash.
 * @param {bigint} right - second hash.
 * @returns {number} the Hamming distance.
 */
export function hammingDistance(left, right) {
  let value = left ^ right
  let count = 0
  while (value > 0n) {
    count += Number(value & 1n)
    value >>= 1n
  }
  return count
}

/**
 * Expand a path into the media files beneath it.
 *
 * Results are sorted by `(kind, lowercased basename)` so two runs over the same
 * folder produce the same inventory regardless of directory enumeration order.
 *
 * @param {string} root - a directory or a single file.
 * @param {object} [options] - listing options.
 * @param {boolean} [options.recursive] - descend into subdirectories. Defaults to true.
 * @returns {{files: string[], skipped: string[]}} discovered files and ignored ones.
 * @throws {MaterialError} when the root does not exist.
 */
export function collectFiles(root, options = {}) {
  const recursive = options.recursive !== false
  const start = resolve(root)

  let stats
  try {
    stats = statSync(start)
  } catch {
    throw new MaterialError(`素材目录不存在：${start}`)
  }
  if (stats.isFile()) return { files: [start], skipped: [] }

  const files = []
  const skipped = []
  const visit = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (recursive) visit(full)
        continue
      }
      if (IGNORED_NAMES.has(entry.name.toLowerCase())) {
        skipped.push(full)
        continue
      }
      if (classify(full) === 'unknown') {
        skipped.push(full)
        continue
      }
      files.push(full)
    }
  }
  visit(start)

  const order = { image: 0, video: 1, audio: 2 }
  files.sort((a, b) => {
    const kindDelta = order[classify(a)] - order[classify(b)]
    if (kindDelta !== 0) return kindDelta
    return basename(a).toLowerCase() < basename(b).toLowerCase() ? -1 : basename(a).toLowerCase() > basename(b).toLowerCase() ? 1 : 0
  })
  skipped.sort()
  return { files, skipped }
}

/**
 * Classify orientation from pixel dimensions.
 * @param {string} kind - the media kind.
 * @param {number} width - display width.
 * @param {number} height - display height.
 * @returns {'portrait'|'landscape'|'square'|'unknown'} the orientation.
 */
function orientationOf(kind, width, height) {
  if (kind === 'audio' || width === 0 || height === 0) return 'unknown'
  if (width === height) return 'square'
  return height > width ? 'portrait' : 'landscape'
}

/**
 * Inventory a material folder.
 *
 * @param {string} root - the folder (or single file) to inventory.
 * @param {object} [options] - inventory options.
 * @param {boolean} [options.recursive] - descend into subdirectories. Defaults to true.
 * @param {boolean} [options.dedupe] - compute perceptual hashes. Defaults to true.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(done: number, total: number, path: string) => void} [options.onProgress] - progress.
 * @returns {Promise<object>} the inventory.
 * @throws {MaterialError} when the root is missing or contains no usable media.
 */
export async function scan(root, options = {}) {
  const { files, skipped: ignored } = collectFiles(root, { recursive: options.recursive })
  if (files.length === 0) {
    throw new MaterialError(`素材目录里没有可用媒体：${resolve(root)}`)
  }

  const config = options.config ?? {}
  const items = []
  const skipped = ignored.map((path) => ({ path, reason: '扩展名不受支持' }))
  const onProgress = options.onProgress

  for (const [index, file] of files.entries()) {
    if (onProgress !== undefined) onProgress(index, files.length, file)
    try {
      const info = await probe(file, config)
      // Probing successfully is not the same as being usable: ffprobe exits 0 on a
      // truncated or corrupt image and simply reports width and height as 0, with the
      // real complaint only on stderr. Catching that here keeps a 0x0 "image" out of
      // the inventory, where it would only surface as a render failure much later.
      const problems = streamProblems(info)
      if (problems.length > 0) {
        skipped.push({ path: info.path, reason: problems.join('；') })
        continue
      }
      items.push({ ...info, orientation: orientationOf(info.kind, info.width, info.height), hash: null, duplicateOf: null })
    } catch (error) {
      skipped.push({ path: file, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  if (options.dedupe !== false) {
    const stills = items.filter((item) => item.kind === 'image')
    for (const [index, item] of stills.entries()) {
      if (onProgress !== undefined) onProgress(index, stills.length, item.path)
      item.hash = await differenceHash(item.path, config)
    }
    // Compare each still only against earlier ones, so a duplicate reports the first
    // occurrence rather than forming chains.
    for (let index = 0; index < stills.length; index += 1) {
      const candidate = stills[index]
      if (candidate.hash === null) continue
      for (let earlier = 0; earlier < index; earlier += 1) {
        const reference = stills[earlier]
        if (reference.hash === null) continue
        if (hammingDistance(candidate.hash, reference.hash) <= DUPLICATE_DISTANCE) {
          candidate.duplicateOf = reference.path
          break
        }
      }
    }
  }

  const images = items.filter((item) => item.kind === 'image')
  const videos = items.filter((item) => item.kind === 'video')
  const audio = items.filter((item) => item.kind === 'audio')

  return {
    root: resolve(root),
    counts: { total: items.length, images: images.length, videos: videos.length, audio: audio.length, skipped: skipped.length },
    images,
    videos,
    audio,
    duplicates: images.filter((item) => item.duplicateOf !== null),
    skipped,
    totalDuration: videos.reduce((sum, item) => sum + item.duration, 0),
  }
}

/** Serialize an inventory for a tool result, dropping the internal hash. */
export function inventoryToJson(inventory) {
  const strip = (item) => {
    const { hash, ...rest } = item
    return rest
  }
  return {
    root: inventory.root,
    counts: inventory.counts,
    images: inventory.images.map(strip),
    videos: inventory.videos.map(strip),
    audio: inventory.audio.map(strip),
    duplicates: inventory.duplicates.map(strip),
    skipped: inventory.skipped,
    totalDuration: inventory.totalDuration,
  }
}

/**
 * Render a short human-readable summary of an inventory.
 * @param {object} inventory - a scan result.
 * @returns {string} a multi-line Chinese summary.
 */
export function describe(inventory) {
  const { counts } = inventory
  const lines = [
    `素材目录：${inventory.root}`,
    '',
    `图片 ${counts.images} 张，视频 ${counts.videos} 段，音频 ${counts.audio} 个`,
  ]
  if (counts.videos > 0) lines.push(`视频素材总时长 ${inventory.totalDuration.toFixed(1)}s`)
  const portraits = inventory.images.filter((item) => item.orientation === 'portrait').length
  if (counts.images > 0) lines.push(`其中竖图 ${portraits} 张，横图 ${counts.images - portraits} 张`)
  if (inventory.duplicates.length > 0) {
    lines.push(`检测到 ${inventory.duplicates.length} 张重复/近似重复图片（已标注，未剔除）`)
  }
  if (counts.skipped > 0) lines.push(`跳过 ${counts.skipped} 个不支持的文件`)
  return lines.join('\n')
}
