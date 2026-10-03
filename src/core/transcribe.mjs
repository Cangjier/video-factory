/**
 * Preparing audio for the host's speech recogniser, and driving it.
 *
 * The recogniser lives in the Host, not in this plugin: the host publishes a
 * `speechToText` service and a local SenseVoice provider behind it. This module is the
 * adapter between a media file on disk and that service.
 *
 * Two host constraints shape everything here:
 *
 * 1. **Input must be canonical 16 kHz mono PCM16 WAV.** The host validates the header
 *    and rejects anything else, so the conversion is not optional.
 * 2. **One request carries at most `maxAudioBytes` (4 MB by default) of audio**, which
 *    at 32 kB/s is roughly 131 seconds. Longer material must be split — and split at a
 *    natural pause, because cutting by byte offset lands mid-word and shows up as a
 *    truncated word in the transcript.
 *
 * @module video-factory/core/transcribe
 */
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './ffmpeg.mjs'

/** Sample rate the host requires. */
export const SAMPLE_RATE = 16_000

/** Bytes per second of 16 kHz mono PCM16 audio. */
export const BYTES_PER_SECOND = SAMPLE_RATE * 2

/** The host's default per-request cap. */
export const DEFAULT_MAX_AUDIO_BYTES = 4 * 1024 * 1024

/** How much quieter than the peak a region must be to count as silence, in dB. */
const SILENCE_NOISE_DB = -35

/** How long a quiet stretch must last to be considered a usable cut point, in seconds. */
const SILENCE_MIN_SECONDS = 0.35

/** Raised when audio cannot be prepared or transcribed. */
export class TranscribeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TranscribeError'
  }
}

/**
 * Rewrite a WAV's length fields so they agree with the file, by walking its chunks.
 *
 * The layout is not the textbook 44-byte header: ffmpeg inserts a `LIST` chunk holding
 * metadata before `data`, which is what the stray value 26 actually is (the LIST length).
 * Writing a size into a fixed offset therefore lands inside a chunk identifier and
 * destroys the file. The `data` chunk is located by walking the chunk list instead, and
 * both the RIFF size and that chunk's size are then set from the real file length.
 *
 * Why this is needed at all: when the output path is given directly, ffmpeg leaves the
 * `data` size at that placeholder rather than the PCM byte count, and the host's
 * validator reads that field — so the audio arrives looking about a millisecond long.
 *
 * @param {string} path - a canonical 16 kHz mono PCM16 WAV to repair in place.
 * @returns {{dataOffset: number, dataBytes: number, headerBytes: number}} what was found.
 * @throws {TranscribeError} when the file is not a usable WAV.
 */
export function repairWavHeader(path) {
  const total = statSync(path).size
  const head = Buffer.alloc(Math.min(total, 4096))
  const handle = openSync(path, 'r+')
  try {
    const read = readSync(handle, head, 0, head.length, 0)
    if (read < 12) throw new TranscribeError(`WAV 头不完整：${path}`)
    if (head.subarray(0, 4).toString('ascii') !== 'RIFF' || head.subarray(8, 12).toString('ascii') !== 'WAVE') {
      throw new TranscribeError(`不是 WAV 文件：${path}`)
    }

    let cursor = 12
    let dataOffset = -1
    while (cursor + 8 <= read) {
      const id = head.subarray(cursor, cursor + 4).toString('ascii')
      const size = head.readUInt32LE(cursor + 4)
      if (id === 'data') {
        dataOffset = cursor + 8
        break
      }
      // Chunks are word-aligned, so an odd size carries one byte of padding.
      cursor += 8 + size + (size % 2)
    }
    if (dataOffset < 0) throw new TranscribeError(`WAV 里没有 data chunk：${path}`)

    const dataBytes = total - dataOffset
    if (dataBytes <= 0) throw new TranscribeError(`WAV 没有音频数据：${path}`)

    const field = Buffer.alloc(4)
    // RIFF size covers everything after its own size field, minus the leading 8 bytes.
    field.writeUInt32LE(total - 8, 0)
    writeSync(handle, field, 0, 4, 4)
    field.writeUInt32LE(dataBytes, 0)
    writeSync(handle, field, 0, 4, dataOffset - 4)
    return { dataOffset, dataBytes, headerBytes: dataOffset }
  } finally {
    closeSync(handle)
  }
}

/**
 * Convert any media file to canonical 16 kHz mono PCM16 WAV.
 *
 * `-vn` drops any video stream, `-ac 1 -ar 16000` produce the layout the host expects,
 * and `pcm_s16le` produces the exact sample format its header check requires.
 *
 * @param {string} source - the media file.
 * @param {string} target - destination `.wav` path.
 * @param {object} [options] - conversion options.
 * @param {object} [options.config] - normalized plugin config.
 * @returns {Promise<{path: string, seconds: number, bytes: number}>} what was written.
 * @throws {TranscribeError} when conversion fails.
 */
export async function toCanonicalWav(source, target, options = {}) {
  try {
    await run({
      tool: 'ffmpeg',
      args: ['-i', source, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', target],
      config: options.config ?? {},
      timeoutMs: 30 * 60 * 1000,
    })
  } catch (error) {
    throw new TranscribeError(
      `音频转换失败（${source}）：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    )
  }
  const repaired = repairWavHeader(target)
  const bytes = statSync(target).size
  const seconds = repaired.dataBytes / BYTES_PER_SECOND
  return { path: target, seconds, bytes }
}

/**
 * Parse ffmpeg's `silencedetect` output into silence intervals.
 *
 * Only the start of each silence is needed as a candidate cut point; the reported end
 * simply bounds how long the pause lasted.
 *
 * @param {string} stderr - ffmpeg's standard error for a silencedetect run.
 * @returns {{start: number, end: number|null}[]} detected silences, in order.
 */
export function parseSilences(stderr) {
  const silences = []
  for (const line of String(stderr).split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (start !== null) {
      silences.push({ start: Number(start[1]), end: null })
      continue
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (end !== null && silences.length > 0) {
      silences[silences.length - 1].end = Number(end[1])
    }
  }
  return silences.filter((entry) => entry.start >= 0)
}

/**
 * Choose cut points so that every resulting piece fits the byte budget.
 *
 * Each cut is placed inside a detected pause if one is available near the limit, which
 * keeps words intact. Without a pause in range the cut falls back to the byte limit and
 * may split a word — that is reported, not hidden.
 *
 * @param {object} input - the request.
 * @param {number} input.totalSeconds - the full audio length.
 * @param {{start: number, end: number|null}[]} input.silences - detected pauses.
 * @param {number} input.maxBytes - the per-request byte budget.
 * @param {number} [input.leadSeconds] - how far back from the limit to look for a pause.
 * @returns {{cuts: number[], forced: number}} cut points in seconds, and how many were forced.
 */
export function planCuts({ totalSeconds, silences, maxBytes, leadSeconds = 25 }) {
  const maxSeconds = maxBytes / BYTES_PER_SECOND
  const cuts = []
  let forced = 0
  let cursor = 0

  while (totalSeconds - cursor > maxSeconds) {
    const limit = cursor + maxSeconds
    const window = limit - leadSeconds
    // Latest pause that still leaves room, so each piece is as full as possible.
    const candidates = silences
      .map((silence) => silence.start)
      .filter((start) => start > cursor + maxSeconds * 0.25 && start <= limit && start >= window)
    if (candidates.length > 0) {
      const chosen = Math.max(...candidates)
      cuts.push(chosen)
      cursor = chosen
    } else {
      cuts.push(limit)
      cursor = limit
      forced += 1
    }
  }
  return { cuts, forced }
}

/**
 * Extract a time range to a WAV file.
 *
 * The range is re-encoded rather than stream-copied. Copying PCM cannot be done from an
 * arbitrary offset: the container is re-muxed while the header still describes the whole
 * original, so the piece arrives with a header that disagrees with its own data length
 * and the recogniser reads it as a fraction of a second long. Re-encoding is lossless for
 * PCM and fast, and it guarantees each piece is a self-consistent WAV.
 *
 * @param {string} source - canonical WAV to cut from.
 * @param {number} from - start offset in seconds.
 * @param {number|null} to - end offset in seconds, or null for the rest.
 * @param {string} target - destination path.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<void>} resolves when written.
 */
async function cutRange(source, from, to, target, config) {
  // `-ss` before `-i` seeks, and the duration is given to the output so the encoder knows
  // where to stop without decoding further than needed.
  const args = ['-ss', from.toFixed(3), '-i', source]
  if (to !== null) args.push('-t', (to - from).toFixed(3))
  args.push('-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', target)
  await run({ tool: 'ffmpeg', args, config: config ?? {}, timeoutMs: 10 * 60 * 1000 })
  // ffmpeg leaves the data-chunk size at a placeholder when writing to a path, and the
  // recogniser validates that field, so every piece is repaired before it is read.
  repairWavHeader(target)
}

/**
 * Transcribe a media file through the host's speech service.
 *
 * @param {object} request - the request.
 * @param {string} request.source - the media file (video or audio).
 * @param {object} request.service - the host's `speechToText` service.
 * @param {string} [request.language] - a language hint; omit for automatic detection.
 * @param {string} [request.providerId] - an exact recogniser id; omit for the default.
 * @param {number} [request.maxAudioBytes] - per-request byte budget. Defaults to 4 MB.
 * @param {object} [request.config] - normalized plugin config.
 * @param {(event: object) => void} [request.onProgress] - progress events.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<object>} the merged transcript and how it was obtained.
 * @throws {TranscribeError} when the recogniser is unavailable or the audio is unusable.
 */
export async function transcribeFile(request) {
  const { source, service, config } = request
  if (service === undefined || service === null) {
    throw new TranscribeError(
      '宿主没有提供 speechToText 服务，语音转文字不可用。' +
        '请在「设置 → 插件管理」里启用 @deepseek-ai/dsh-experimental-voice-input-bundle，然后重启 DSH。',
    )
  }

  const scratch = mkdtempSync(join(tmpdir(), 'vf-asr-'))
  const full = join(scratch, 'full.wav')
  try {
    request.onProgress?.({ phase: 'converting' })
    const converted = await toCanonicalWav(source, full, { config })
    if (converted.seconds <= 0) {
      throw new TranscribeError(`音频是空的：${source}`)
    }

    const maxBytes = request.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES
    let pieces
    let forcedCuts = 0

    if (converted.bytes <= maxBytes) {
      pieces = [{ path: full, from: 0, to: converted.seconds }]
    } else {
      request.onProgress?.({ phase: 'detecting-silence', seconds: converted.seconds })
      // `silencedetect` only reports to stderr, and a nonzero exit is normal when the
      // input is quiet enough to contain no speech at all.
      let stderr = ''
      try {
        const probe = await run({
          tool: 'ffmpeg',
          args: [
            '-i', full,
            '-af', `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
            '-f', 'null', '-',
          ],
          config: config ?? {},
          timeoutMs: 30 * 60 * 1000,
        })
        stderr = probe.stderr
      } catch (error) {
        stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : ''
      }
      const silences = parseSilences(stderr)
      const plan = planCuts({ totalSeconds: converted.seconds, silences, maxBytes })
      forcedCuts = plan.forced

      pieces = []
      let cursor = 0
      const bounds = [...plan.cuts, converted.seconds]
      for (const [index, end] of bounds.entries()) {
        const path = join(scratch, `part-${String(index).padStart(3, '0')}.wav`)
        await cutRange(full, cursor, end, path, config)
        pieces.push({ path, from: cursor, to: end })
        cursor = end
      }
      request.onProgress?.({ phase: 'split', pieces: pieces.length, forcedCuts })
    }

    const parts = []
    let totalInferenceSeconds = 0
    for (const [index, piece] of pieces.entries()) {
      request.onProgress?.({ phase: 'transcribing', index: index + 1, total: pieces.length })
      const audio = new Uint8Array(readFileSync(piece.path))
      const spec = service.resolve({
        audio,
        ...(request.language === undefined || request.language === null || request.language === ''
          ? {}
          : { language: request.language }),
        ...(request.providerId === undefined || request.providerId === null || request.providerId === ''
          ? {}
          : { providerId: request.providerId }),
      })
      const transcript = await service.transcribe(spec, request.signal ?? new AbortController().signal)
      totalInferenceSeconds += transcript.inferenceSeconds
      parts.push({
        text: transcript.text,
        from: piece.from,
        to: piece.to,
        audioSeconds: transcript.audioSeconds,
        inferenceSeconds: transcript.inferenceSeconds,
      })
    }

    return {
      source,
      text: parts.map((part) => part.text).join('\n').trim(),
      parts,
      pieceCount: parts.length,
      audioSeconds: Number(converted.seconds.toFixed(3)),
      inferenceSeconds: Number(totalInferenceSeconds.toFixed(3)),
      forcedCuts,
      wavBytes: converted.bytes,
      note:
        forcedCuts > 0
          ? `${forcedCuts} 处切分没有找到静音点，是按字节上限硬切的，该处可能截断一个词。`
          : undefined,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
