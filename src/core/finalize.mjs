/**
 * The single video re-encode: mix audio, normalize loudness, and add subtitles.
 *
 * Everything that changes the picture or the soundtrack converges here, so the video
 * is encoded at most once. When subtitles are not burned in, the picture is stream
 * copied and only the audio is rebuilt, which keeps a re-run cheap in the common case
 * of "the subtitles changed".
 *
 * @module video-factory/core/finalize
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { FFmpegError, run } from './ffmpeg.mjs'
import { BuildError } from './scene.mjs'
import { subtitleStyle } from './filter.mjs'
import { QUALITY } from './plan.mjs'
import { probe } from './probe.mjs'

/** How long a single subtitle-burn pass may take. */
const ENCODE_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Copy a subtitle file into the working directory as BOM-free UTF-8.
 *
 * libass treats a byte-order mark as a stray glyph and renders a GBK file as mojibake,
 * so the text is re-encoded rather than passed through.
 * @param {object} plan - the plan, supplying the subtitle block.
 * @param {string} workDir - the working directory.
 * @returns {string|null} the staged filename relative to the working directory, or null.
 * @throws {BuildError} when the subtitle file is missing.
 */
export function stageSubtitles(plan, workDir) {
  if (!plan.subtitles.enabled || plan.subtitles.source === null || plan.subtitles.source === '') return null
  const source = plan.subtitles.source
  if (!existsSync(source)) throw new BuildError(`找不到字幕文件：${source}`)
  const staged = extname(source).toLowerCase() === '.ass' ? 'vf_subs.ass' : 'vf_subs.srt'
  // A BOM renders as a stray glyph in libass and a GBK file renders as mojibake, so
  // the bytes are decoded leniently and rewritten as plain UTF-8 without a preamble.
  const bytes = readFileSync(source)
  let text = bytes.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  writeFileSync(join(workDir, staged), text, { encoding: 'utf8' })
  return staged
}

/**
 * Mix audio, normalize loudness, and add subtitles, producing `final.mp4`.
 *
 * @param {string} timeline - the assembled timeline.
 * @param {object} plan - the enclosing plan.
 * @param {object} options - finalize options.
 * @param {string} options.workDir - the working directory; also the working directory
 *   of the ffmpeg process, so that relative font and subtitle paths resolve.
 * @param {string} options.outDir - destination for `final.mp4`.
 * @param {boolean} [options.force] - re-encode even when the output exists.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(line: string) => void} [options.onProgress] - ffmpeg progress lines.
 * @returns {Promise<{path: string, reused: boolean, duration: number, burned: boolean, softSubs: boolean, seconds: number}>}
 * @throws {BuildError} when the encode fails.
 */
export async function finalize(timeline, plan, options) {
  const workDir = options.workDir
  const outDir = options.outDir
  mkdirSync(outDir, { recursive: true })
  const target = join(outDir, 'final.mp4')
  const started = Date.now()

  if (!options.force && existsSync(target) && statSync(target).size > 0) {
    const info = await probe(target, options.config ?? {})
    return { path: target, reused: true, duration: info.duration, burned: false, softSubs: false, seconds: 0 }
  }
  if (!existsSync(timeline)) throw new BuildError(`找不到时间线：${timeline}`)

  const duration = (await probe(timeline, options.config ?? {})).duration
  const timelineAbsolute = timeline.startsWith('.') ? timeline : timeline

  const inputs = ['-i', timelineAbsolute]
  const filters = []
  const audioLabels = ['0:a']
  let voiceLabel = null
  let voiceIndex = null
  let musicIndex = null

  if (plan.audio.voiceover !== null) {
    if (!existsSync(plan.audio.voiceover)) {
      throw new BuildError(`找不到配音文件：${plan.audio.voiceover}`)
    }
    // Record the index as the input is added rather than deriving it later: the number
    // of inputs before this one depends on which optional tracks the plan enables.
    voiceIndex = inputs.filter((token) => token === '-i').length
    inputs.push('-i', plan.audio.voiceover)
    voiceLabel = 'voc'
    filters.push(`[${voiceIndex}:a]aresample=48000[pv]`)
    filters.push('[pv]asplit=2[voc][sc]')
    audioLabels.push('voc')
  }

  if (plan.audio.music !== null) {
    if (!existsSync(plan.audio.music)) throw new BuildError(`找不到背景音乐：${plan.audio.music}`)
    musicIndex = inputs.filter((token) => token === '-i').length
    inputs.push('-stream_loop', '-1', '-i', plan.audio.music)
    const fadeOutStart = Math.max(duration - plan.audio.fadeOut, 0)
    const chain =
      `[${musicIndex}:a]aresample=48000,volume=${plan.audio.musicGainDb}dB,` +
      `atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${Math.max(plan.audio.fadeIn, 0.01).toFixed(3)},` +
      `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${Math.max(plan.audio.fadeOut, 0.01).toFixed(3)}`
    if (voiceLabel !== null && plan.audio.duck) {
      // Ducking runs the narration as the sidechain, so the music drops only while
      // someone is actually speaking.
      filters.push(`${chain}[bgm]`)
      filters.push('[bgm][sc]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300:makeup=1[mduck]')
      audioLabels.push('mduck')
    } else {
      filters.push(`${chain}[bgm]`)
      audioLabels.push('bgm')
    }
  }

  let effectiveLabels = audioLabels
  if (!plan.audio.keepSceneAudio && voiceLabel !== null) {
    effectiveLabels = audioLabels.filter((label) => label !== '0:a')
  }

  let audioSource
  // A plan with no voiceover and no music still leaves the timeline carrying a silent track, and
  // that silence reaches `loudnorm` as pure digital zero. `loudnorm` responds by emitting NaN,
  // which the AAC encoder rejects outright ("Input contains (near) NaN/+-Inf") — so a plan whose
  // audio block is empty used to fail at the last step with a message that names the encoder and
  // never mentions loudness. Loudness normalisation of silence is also meaningless: there is no
  // signal to measure. Silence therefore skips it and only pins the format the encoder wants.
  let silentSource = false
  if (effectiveLabels.length > 1) {
    const mixed = effectiveLabels.map((label) => `[${label}]`).join('')
    // `normalize=0` is required: the amix default halves every input's level.
    filters.push(`${mixed}amix=inputs=${effectiveLabels.length}:duration=first:dropout_transition=0:normalize=0[amixed]`)
    audioSource = 'amixed'
  } else if (effectiveLabels.length === 1 && effectiveLabels[0] === '0:a') {
    filters.push('[0:a]anull[amixed]')
    audioSource = 'amixed'
    silentSource = true
  } else if (effectiveLabels.length === 1) {
    audioSource = effectiveLabels[0]
  } else {
    throw new BuildError('finalize：没有任何音轨可混（keep_scene_audio 关掉了场景声，但也没有配音）')
  }

  // The scene tracks are generated as silence by the renderer, so a plan that adds neither a
  // voiceover nor music is silent by construction rather than by content.
  const hasOwnAudio = voiceLabel !== null || musicIndex !== null
  if (silentSource && !hasOwnAudio) {
    filters.push(`[${audioSource}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`)
  } else {
    filters.push(`[${audioSource}]loudnorm=I=${plan.audio.loudnessTarget.toFixed(1)}:TP=-1.5:LRA=11[aout]`)
  }

  // Subtitles are the only thing that touches the picture. When they are burned in, the
  // video joins the filter graph and is re-encoded; when they are not, the graph holds
  // audio only, which lets `-map 0:v -c:v copy` stream the picture through untouched.
  //
  // Both alternatives are wrong: `-map 0:v` alongside a graph that also feeds video is
  // rejected ("Output with label '0:v' does not exist in any defined filter graph"), and
  // routing the video through a `null` graph node is also rejected, because a filtergraph
  // output cannot be stream-copied ("Filtering and streamcopy cannot be used together").
  let burned = false
  let videoOut = '0:v'
  const stagedSubs = stageSubtitles(plan, workDir)
  if (stagedSubs !== null && plan.subtitles.burn) {
    const fontsDir = existsSync(join(workDir, 'fonts')) ? ":fontsdir='fonts'" : ''
    filters.push(
      `[0:v]subtitles='${stagedSubs}'${fontsDir}:force_style='${subtitleStyle(plan.subtitles, plan)}'[vout]`,
    )
    videoOut = 'vout'
    burned = true
  }

  const quality = QUALITY[plan.quality] ?? QUALITY.high
  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', videoOut.startsWith('0:') ? videoOut : `[${videoOut}]`,
    '-map', '[aout]',
  ]
  if (!burned) {
    args.push('-c:v', 'copy')
  } else {
    args.push(
      '-c:v', 'libx264', '-preset', quality.preset, '-crf', String(quality.crf),
      '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-profile:v', 'high', '-level', '4.1',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    )
  }
  args.push(
    '-c:a', 'aac', '-b:a', quality.audioBitrate, '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-t', duration.toFixed(3),
    target,
  )

  try {
    await run({
      tool: 'ffmpeg',
      args,
      cwd: workDir,
      config: options.config ?? {},
      timeoutMs: ENCODE_TIMEOUT_MS,
      onStderr: options.onProgress,
    })
  } catch (error) {
    throw new BuildError(`合成失败。\n${error instanceof FFmpegError ? error.message : String(error)}`)
  }

  // Soft subtitles are a second, cheap pass: the picture is copied, only a subtitle
  // track is muxed in.
  let softSubs = false
  if (stagedSubs !== null && !plan.subtitles.burn) {
    const soft = join(outDir, 'final.softsub.mp4')
    try {
      await run({
        tool: 'ffmpeg',
        args: [
          '-i', target,
          '-i', join(workDir, stagedSubs),
          '-map', '0', '-map', '1',
          '-c', 'copy', '-c:s', 'mov_text',
          '-metadata:s:s:0', 'language=chi',
          soft,
        ],
        config: options.config ?? {},
        timeoutMs: 15 * 60 * 1000,
        onStderr: options.onProgress,
      })
    } catch (error) {
      throw new BuildError(`软字幕封装失败。\n${error instanceof FFmpegError ? error.message : String(error)}`)
    }
    copyFileSync(soft, target)
    softSubs = true
  }

  return {
    path: target,
    reused: false,
    duration,
    burned,
    softSubs,
    seconds: (Date.now() - started) / 1000,
  }
}
