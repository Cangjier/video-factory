/**
 * `video_narrate` actions: speech synthesis and the subtitle primitives.
 *
 * Synthesis and cue-building are separate actions because they have different costs.
 * Synthesis touches the network and produces a file; splitting words into cues is pure
 * computation that can be re-run with a different line length for free. Binding them
 * together — as the previous one-shot `narrate` command did — forces a fresh
 * synthesis every time a subtitle tweak is wanted.
 *
 * The actions remember their last output, so `to_cues` can follow `synthesize` without
 * the caller threading a path through, while an explicit path still wins.
 *
 * @module video-factory/tools/narrate-actions
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { AudioError, synthesize } from '../core/tts.mjs'
import { formatSrt, parseSrt, scaleCues, wordsToCues } from '../core/srt.mjs'
import { BYTES_PER_SECOND, DEFAULT_MAX_AUDIO_BYTES, TranscribeError, transcribeFile } from '../core/transcribe.mjs'
import { VideoFactoryError } from './shared.mjs'

/** Default per-request budget in seconds, chosen to stay inside the host's 4 MB cap. */
const DEFAULT_MAX_AUDIO_SECONDS = Math.floor(DEFAULT_MAX_AUDIO_BYTES / BYTES_PER_SECOND)

/**
 * Build the `video_narrate` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createNarrateActions(config, logger) {
  // Remembered between calls so the natural sequence needs no path juggling.
  let lastWordsPath = null
  let lastCuesPath = null
  let lastStyle = null

  const readWords = (args, cwd) => {
    const path =
      typeof args.wordsPath === 'string' && args.wordsPath !== ''
        ? resolve(cwd, args.wordsPath)
        : lastWordsPath
    if (path === null) {
      throw new VideoFactoryError(
        'video_narrate to_cues: 没有可用的逐词时间戳。请先调用 video_narrate {action:"synthesize"}，或显式传 "wordsPath"。',
      )
    }
    if (!existsSync(path)) throw new VideoFactoryError(`video_narrate to_cues: 找不到时间戳文件 ${path}`)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { path, words: Array.isArray(parsed) ? parsed : (parsed.words ?? []) }
  }

  const readCues = (args, cwd) => {
    const path =
      typeof args.cuesPath === 'string' && args.cuesPath !== ''
        ? resolve(cwd, args.cuesPath)
        : lastCuesPath
    if (path === null) {
      throw new VideoFactoryError(
        'video_narrate srt_write: 没有可用的字幕条。请先调用 video_narrate {action:"to_cues"}，或显式传 "cuesPath"。',
      )
    }
    if (!existsSync(path)) throw new VideoFactoryError(`video_narrate srt_write: 找不到字幕文件 ${path}`)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { path, cues: Array.isArray(parsed) ? parsed : (parsed.cues ?? []) }
  }

  return {
    /**
     * Synthesize narration and report the word timings.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the audio path, word timings, and duration.
     */
    async synthesize(args, context) {
      let text = typeof args.text === 'string' ? args.text : ''
      if (text.trim() === '' && typeof args.textPath === 'string' && args.textPath !== '') {
        const path = resolve(context.cwd, args.textPath)
        if (!existsSync(path)) throw new VideoFactoryError(`video_narrate synthesize: 找不到文案文件 ${path}`)
        text = readFileSync(path, 'utf8')
        // Strip a BOM: PowerShell's default UTF-8 writer emits one.
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      if (text.trim() === '') {
        throw new VideoFactoryError('video_narrate synthesize: 需要 "text"（内联文案）或 "textPath"（文案文件）。')
      }

      const outDir =
        typeof args.outDir === 'string' && args.outDir !== ''
          ? resolve(context.cwd, args.outDir)
          : join(context.cwd, 'narration')
      mkdirSync(outDir, { recursive: true })
      const audioPath = join(outDir, 'voiceover.mp3')
      const wordsPath = join(outDir, 'voiceover.words.json')

      let result
      try {
        result = await synthesize({
          text,
          voice: args.voice ?? config.tts.voice,
          rate: args.rate ?? config.tts.rate,
          pitch: args.pitch ?? config.tts.pitch,
          volume: args.volume ?? config.tts.volume,
        })
      } catch (error) {
        if (error instanceof AudioError) throw new VideoFactoryError(`配音失败：${error.message}`)
        throw error
      }

      writeFileSync(audioPath, result.audio)
      writeFileSync(wordsPath, `${JSON.stringify({ audio: audioPath, duration: result.duration, words: result.words }, null, 2)}\n`, {
        encoding: 'utf8',
      })
      lastWordsPath = wordsPath
      logger.info(`video-factory: 配音完成 ${result.duration.toFixed(1)}s，${result.words.length} 个词`)

      return {
        audio: audioPath,
        wordsPath,
        duration: Number(result.duration.toFixed(3)),
        wordCount: result.words.length,
        firstWords: result.words.slice(0, 5).map((word) => `${word.text}@${word.start.toFixed(2)}`),
        planFragment: { voiceover: audioPath },
      }
    },

    /**
     * Turn word timings into subtitle cues.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the cues and their file.
     */
    async to_cues(args, context) {
      const { words, path } = readWords(args, context.cwd)
      if (words.length === 0) throw new VideoFactoryError(`video_narrate to_cues: ${path} 里没有词。`)
      const cues = wordsToCues(words, { maxChars: args.maxChars ?? 18 })
      const cuesPath = join(dirname(path), 'voiceover.cues.json')
      writeFileSync(cuesPath, `${JSON.stringify({ audio: null, cues }, null, 2)}\n`, { encoding: 'utf8' })
      lastCuesPath = cuesPath

      return {
        cuesPath,
        cueCount: cues.length,
        cues,
        note: '断句规则：句末标点、词间静音 ≥0.45s、单条累计 ≥6s；要只按标点断句请改调 video_narrate 的实现参数。',
      }
    },

    /**
     * Serialize cues to an SRT file.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the written path.
     */
    async srt_write(args, context) {
      const { cues, path } = readCues(args, context.cwd)
      const srtPath =
        typeof args.srtPath === 'string' && args.srtPath !== ''
          ? resolve(context.cwd, args.srtPath)
          : join(dirname(path), 'voiceover.srt')
      writeFileSync(srtPath, formatSrt(cues), { encoding: 'utf8' })
      return { srt: srtPath, cueCount: cues.length, source: path }
    },

    /**
     * Parse an SRT file into cues.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the parsed cues.
     */
    async srt_read(args, context) {
      if (typeof args.srtPath !== 'string' || args.srtPath === '') {
        throw new VideoFactoryError('video_narrate srt_read: 需要 "srtPath"。')
      }
      const srtPath = resolve(context.cwd, args.srtPath)
      if (!existsSync(srtPath)) throw new VideoFactoryError(`video_narrate srt_read: 找不到字幕文件 ${srtPath}`)
      const cues = parseSrt(readFileSync(srtPath, 'utf8'))
      return { srt: srtPath, cueCount: cues.length, cues }
    },

    /**
     * Compute burn-in style values for a canvas.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} a plan.json `subtitles` fragment.
     */
    async layout(args, context) {
      const width = Number.isFinite(args.canvasWidth) ? args.canvasWidth : 1080
      const height = Number.isFinite(args.canvasHeight) ? args.canvasHeight : 1920
      // Font size and bottom margin are expressed against a 1080-wide canvas in
      // plan.json, so a differently sized canvas is scaled to match.
      const scale = width / 1080
      const style = {
        enabled: true,
        burn: true,
        font_size: Math.round(44 * scale),
        margin_v: Math.round(height * 0.104),
        primary_color: '#FFFFFF',
        outline_color: '#000000',
        outline: 3,
        max_chars_per_line: args.maxChars ?? 18,
      }

      let cueCount = null
      let source = null
      try {
        const { cues, path } = readCues(args, context.cwd)
        cueCount = cues.length
        source = path
        if (Number.isFinite(args.scale) && args.scale > 0 && args.scale !== 1) {
          const scaled = scaleCues(cues, args.scale)
          const cuesPath = join(dirname(path), 'voiceover.scaled.cues.json')
          writeFileSync(cuesPath, `${JSON.stringify({ audio: null, cues: scaled }, null, 2)}\n`, { encoding: 'utf8' })
          lastCuesPath = cuesPath
          style.source = null
          lastStyle = { ...style, scaledCuesPath: cuesPath }
          return { subtitles: style, cueCount, source, scaledCuesPath: cuesPath, note: '时间轴已按 scale 缩放并另存，请把该路径写进 plan.json 的 subtitles.source。' }
        }
      } catch {
        // Style is still useful without cues; the caller may only want the numbers.
      }

      lastStyle = style
      return {
        subtitles: style,
        cueCount,
        source,
        note: '把 subtitles 填进 plan.json；别忘了解析出的 .srt 要写进 subtitles.source。',
      }
    },

    /**
     * Transcribe an existing audio or video file with the host's local recogniser.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context, carrying the host's `speechToText` service.
     * @returns {Promise<object>} the transcript.
     */
    async transcribe(args, context) {
      if (typeof args.audioPath !== 'string' || args.audioPath === '') {
        throw new VideoFactoryError('video_narrate transcribe: 需要 "audioPath"（要转录的音视频文件）。')
      }
      const source = resolve(context.cwd, args.audioPath)
      if (!existsSync(source)) throw new VideoFactoryError(`video_narrate transcribe: 文件不存在 ${source}`)

      const service = context.speechToText
      if (service === undefined || service === null) {
        throw new VideoFactoryError(
          'video_narrate transcribe: 宿主没有提供 speechToText 服务，语音转文字不可用。' +
            '请在「设置 → 插件管理」里启用语音输入 bundle（@deepseek-ai/dsh-experimental-voice-input-bundle）并重启 DSH。',
        )
      }

      const maxAudioSeconds = Number.isFinite(args.maxAudioSeconds) ? args.maxAudioSeconds : DEFAULT_MAX_AUDIO_SECONDS
      const maxAudioBytes = Math.max(1024, Math.floor(maxAudioSeconds * BYTES_PER_SECOND))

      // Report what the recogniser says it is, so a "wrong language" complaint can be
      // traced to the actual provider rather than guessed at.
      let providerInfo = null
      try {
        const snapshot = service.snapshot()
        const selected = snapshot?.selection?.providerId
        providerInfo = snapshot?.providers?.find((entry) => entry.id === selected) ?? null
        if (providerInfo !== null && providerInfo.preparation?.phase === 'unprepared') {
          logger.warn('video_narrate transcribe: 本地识别模型尚未就绪，首次使用会先下载模型')
        }
      } catch {
        // A snapshot is diagnostic only; transcription can still proceed without it.
      }

      try {
        const result = await transcribeFile({
          source,
          service,
          language: args.language === 'auto' ? undefined : args.language,
          maxAudioBytes,
          config,
          onProgress: (event) => {
            if (event.phase === 'converting') logger.info(`video-factory: 抽取音频 ${source}`)
            else if (event.phase === 'detecting-silence') logger.info(`video-factory: 音频 ${event.seconds.toFixed(1)}s，正在找静音断点`)
            else if (event.phase === 'split') logger.info(`video-factory: 切成 ${event.pieces} 段（硬切 ${event.forcedCuts} 处）`)
            else if (event.phase === 'transcribing') logger.info(`video-factory: 转录第 ${event.index}/${event.total} 段`)
          },
        })
        return { ...result, provider: providerInfo === null ? null : { id: providerInfo.id, name: providerInfo.name, location: providerInfo.location } }
      } catch (error) {
        if (error instanceof TranscribeError) throw new VideoFactoryError(`转录失败：${error.message}`)
        throw error
      }
    },
  }
}
