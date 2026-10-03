#!/usr/bin/env node
/**
 * The optional command line.
 *
 * It exposes the same operations the `video_*` tools do, for two reasons: a stage can
 * be debugged without an agent in the loop, and the test suite can exercise the real
 * code paths. It deliberately has no one-shot "make me a video" subcommand — sequencing
 * is the caller's job, which is the whole point of the plugin's design.
 *
 * Usage: node src/bin/vf.mjs <command> [options]
 *
 * @module video-factory/bin
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { capabilitiesOf, resolveBinary, versionOf, vendoredBuild } from '../core/env.mjs'
import { installFfmpeg, vendoredState } from '../core/install.mjs'
import { installOcr, ocrInstallState, removeOcr } from '../core/ocr-install.mjs'
import { findLines, ocrReport, parseRegion, readText } from '../core/ocr.mjs'
import { sampleFrames } from '../core/sampling.mjs'
import { audioEventState, detectAudioEvents } from '../core/audio-events.mjs'
import { installAudio, removeAudio, verifyInstalledAudio } from '../core/audio-install.mjs'
import { matteImage, matteState } from '../core/matte.mjs'
import { installMatte, removeMatte, verifyInstalledMatte } from '../core/matte-install.mjs'
import { describe as describeInventory, inventoryToJson, scan } from '../core/materials.mjs'
import { estimatedDuration, fieldReference, loadResolvedPlan } from '../core/plan.mjs'
import { probe } from '../core/probe.mjs'
import { build } from '../core/pipeline.mjs'
import { assemble } from '../core/assemble.mjs'
import { deliver } from '../core/deliver.mjs'
import { finalize } from '../core/finalize.mjs'
import { clipPath, renderScene } from '../core/scene.mjs'
import { synthesize } from '../core/tts.mjs'
import { formatSrt, wordsToCues } from '../core/srt.mjs'
import { makeTestMaterial } from './make-test-material.mjs'

/** Print a JSON result. */
const emit = (value) => console.log(JSON.stringify(value, null, 2))

/** Drop keys whose value is `undefined`, so a core default is not overwritten by absence. */
const defined = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

/** Parse an optional numeric option. */
const numberOrUndefined = (value) => (value === undefined ? undefined : Number(value))

/** Resolve the out/work directories for a render command. */
function renderDirs(plan, options) {
  const outDir = options.out === undefined ? join(plan.baseDir, 'output') : resolve(options.out)
  const workDir = options.work === undefined ? join(outDir, '.work') : resolve(options.work)
  return { outDir, workDir }
}

const COMMANDS = {
  /**
   * Report the environment, mirroring `video_env {action:"probe"}`.
   */
  async doctor() {
    const problems = []
    const ffmpeg = resolveBinary('ffmpeg', null)
    const ffprobe = resolveBinary('ffprobe', null)
    if (ffmpeg === null) problems.push('找不到 ffmpeg')
    if (ffprobe === null) problems.push('找不到 ffprobe')

    const report = {
      ok: problems.length === 0,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      ffmpeg: ffmpeg === null ? { found: false } : { found: true, path: ffmpeg },
      ffprobe: ffprobe === null ? { found: false } : { found: true, path: ffprobe },
      vendored: vendoredBuild(),
      ocr: ocrReport({}),
      audio: audioEventState(),
      matte: matteState(),
      arkKeyPresent: typeof process.env.ARK_API_KEY === 'string' && process.env.ARK_API_KEY !== '',
      problems,
    }
    if (ffmpeg !== null) {
      report.ffmpeg.version = await versionOf(ffmpeg)
      const capabilities = await capabilitiesOf(ffmpeg)
      report.ffmpeg.encoders = capabilities.encoders
      report.ffmpeg.filters = capabilities.filters
      for (const name of ['libx264', 'aac']) {
        if (!capabilities.encoders.includes(name)) problems.push(`缺少编码器 ${name}`)
      }
      for (const name of ['zoompan', 'xfade', 'loudnorm', 'subtitles']) {
        if (!capabilities.filters.includes(name)) problems.push(`缺少滤镜 ${name}`)
      }
      report.ok = problems.length === 0
    }
    emit(report)
    return report.ok ? 0 : 1
  },

  /** Install ffmpeg into vendor/. */
  async install(options) {
    const result = await installFfmpeg({
      force: options.force === true,
      onProgress: (message) => console.error(message),
    })
    emit({ ...result, state: vendoredState() })
    return 0
  },

  /** Install, or remove, an offline OCR engine. */
  async 'install-ocr'(options) {
    if (options.remove === true) {
      const result = removeOcr(options.source)
      emit({ ...result, state: ocrInstallState() })
      return 0
    }
    const result = await installOcr({
      source: options.source,
      force: options.force === true,
      prune: options.prune === true,
      archive: options.archive,
      onProgress: (message) => console.error(message),
    })
    emit({ ...result, state: ocrInstallState() })
    return 0
  },

  /** Read text off an image or a video, and optionally locate a string in it. */
  async ocr(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('ocr: <文件> is required')
    const config = { ocr: { defaultEngine: options.engine ?? 'auto' } }
    const read = await readText(resolve(target), {
      config,
      engine: options.engine,
      region: parseRegion(options.region),
      scale: options.scale === undefined ? undefined : options.scale === 'auto' ? 'auto' : Number(options.scale),
      language: options.language,
      maxSideLen: options['max-side'] === undefined ? undefined : Number(options['max-side']),
      frames: options.frames === undefined ? undefined : Number(options.frames),
      onLog: (message) => console.error(message),
    })
    const matches = options.find === undefined ? null : findLines(read.lines, [options.find], { match: options.match })
    if (options.json === true) emit({ ...read, matches })
    else {
      console.log(`引擎 ${read.engine}，${read.lines.length} 行，${read.elapsedMs} ms`)
      for (const line of read.lines) {
        console.log(`  ${String(line.score ?? '-').padEnd(6)} [${line.x},${line.y} ${line.width}x${line.height}] ${line.text}`)
      }
      if (matches !== null) {
        console.log(`\n找到 ${matches.length} 处 "${options.find}"：`)
        for (const match of matches) console.log(`  ${match.center.x},${match.center.y}  ${match.text}`)
      }
    }
    return options.find === undefined || matches.length > 0 ? 0 : 1
  },

  /** Install, or remove, the audio event detection model and runtime. */
  async 'install-audio'(options) {
    if (options.remove === true) {
      const result = removeAudio({ onProgress: (message) => console.error(message) })
      emit({ ...result, state: audioEventState() })
      return 0
    }
    const result = await installAudio({
      force: options.force === true,
      modelArchive: options.archive,
      onProgress: (message) => console.error(message),
    })
    emit({ ...result, state: audioEventState(), verify: verifyInstalledAudio() })
    return 0
  },

  /** Sample the moments of a video worth looking at. */
  async frames(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('frames: <视频> is required')
    const report = await sampleFrames(resolve(target), {
      config: {},
      // Drop anything not given on the command line: an explicit `undefined` would overwrite
      // the core defaults rather than deferring to them.
      ...defined({
        strategy: options.strategy,
        probeFps: numberOrUndefined(options['probe-fps']),
        targetFps: numberOrUndefined(options['target-fps']),
        sceneThreshold: numberOrUndefined(options['scene-threshold']),
        motionThreshold: numberOrUndefined(options['motion-threshold']),
        maxFrames: numberOrUndefined(options['max-frames']),
      }),
    })
    if (options.json === true) emit(report)
    else {
      console.log(
        `${report.duration}s，探测 ${report.probe.width}x${report.probe.height}@${report.probe.fps} ` +
          `共 ${report.probe.decodedFrames} 帧，选中 ${report.frames.length} 帧（跳过 ${report.skipped}）`,
      )
      for (const frame of report.frames) {
        console.log(
          `  ${String(frame.at).padStart(8)}s  ${frame.reason.padEnd(23)} ` +
            `scene=${String(frame.sceneScore).padStart(7)}  gap=${frame.gapFromPrevious}`,
        )
      }
    }
    return 0
  },

  /** Classify a soundtrack into timestamped acoustic events. */
  async audio(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('audio: <文件> is required')
    const report = await detectAudioEvents(resolve(target), {
      config: {},
      ...defined({
        start: numberOrUndefined(options.start),
        duration: numberOrUndefined(options.duration),
        topK: numberOrUndefined(options['top-k']),
        minScore: numberOrUndefined(options['min-score']),
      }),
    })
    if (options.json === true) emit(report)
    else {
      console.log(
        `${report.durationSec.toFixed(2)}s，${report.soundtrack.windows} 个分析窗` +
          `（分类 ${report.soundtrack.classified}，静音 ${report.soundtrack.silent}）`,
      )
      console.log('\n事件（标签 → 时间点）：')
      for (const [label, times] of Object.entries(report.events)) {
        console.log(`  ${label.padEnd(24)} ${times.length} 次  ${times.slice(0, 8).join(', ')}${times.length > 8 ? ' …' : ''}`)
      }
      console.log('\n逐窗：')
      for (const segment of report.segments) {
        const labels = segment.silent
          ? '(静音)'
          : segment.labels.map((l) => `${l.label} ${l.score}`).join(' | ')
        console.log(`  ${String(segment.at).padStart(8)}s  rms=${String(segment.rms).padEnd(8)} ${labels}`)
      }
    }
    return 0
  },

  /** Install, or remove, the matting model. */
  async 'install-matte'(options) {
    if (options.remove === true) {
      const result = removeMatte({ onProgress: (message) => console.error(message) })
      emit({ ...result, state: matteState() })
      return 0
    }
    const result = await installMatte({
      force: options.force === true,
      modelArchive: options.archive,
      onProgress: (message) => console.error(message),
    })
    emit({ ...result, state: matteState(), verify: verifyInstalledMatte() })
    return 0
  },

  /** Cut a subject out of its backdrop, one image or one frame of a video. */
  async matte(options) {
    const target = options.paths?.[0]
    if (target === undefined) throw new Error('matte: <图片或视频> is required')
    const result = await matteImage(resolve(target), resolve(options.out ?? 'matte.png'), {
      config: {},
      at: numberOrUndefined(options.at),
      feather: numberOrUndefined(options.feather),
      keepMask: options['keep-mask'] === true,
    })
    if (options.json === true) emit(result)
    else {
      console.log(
        `抠图完成：${result.width}x${result.height}，推理 ${result.inferenceMs} ms，` +
          `前景占比 ${(result.statistics.foregroundRatio * 100).toFixed(2)}%`,
      )
      console.log(`  ${result.path}`)
      if (result.maskPath !== null) console.log(`  遮罩：${result.maskPath}`)
    }
    return result.statistics.foregroundRatio < 0.005 || result.statistics.foregroundRatio > 0.995 ? 1 : 0
  },

  /** Inventory a material folder. */
  async scan(options) {
    const inventory = await scan(options.path ?? '.', {
      recursive: options['no-recursive'] !== true,
      dedupe: options['no-dedupe'] !== true,
    })
    if (options.json === true) emit(inventoryToJson(inventory))
    else {
      console.log(describeInventory(inventory))
      console.log()
      emit(inventory.counts)
    }
    return 0
  },

  /** Print the plan field reference. */
  async fields() {
    console.log(fieldReference())
    return 0
  },

  /** Validate a plan and report its timeline length. */
  async check(options) {
    if (options.plan === undefined) throw new Error('check: --plan <plan.json> is required')
    const plan = loadResolvedPlan(options.plan)
    emit({
      ok: true,
      canvas: `${plan.width}x${plan.height}@${plan.fps}`,
      quality: plan.quality,
      sceneCount: plan.scenes.length,
      estimatedDuration: Number(estimatedDuration(plan.scenes).toFixed(3)),
      subtitles: plan.subtitles.enabled ? plan.subtitles.source : null,
      voiceover: plan.audio.voiceover,
      music: plan.audio.music,
    })
    return 0
  },

  /** Synthesize narration and write audio, word timings, and an SRT. */
  async narrate(options) {
    if (options.text === undefined) throw new Error('narrate: --text <file.txt> is required')
    const text = readFileSync(options.text, 'utf8')
    const outDir = resolve(options.out ?? 'narration')
    const result = await synthesize({ text, voice: options.voice ?? undefined })
    const audioPath = join(outDir, 'voiceover.mp3')
    const wordsPath = join(outDir, 'voiceover.words.json')
    const srtPath = join(outDir, 'voiceover.srt')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(audioPath, result.audio)
    const cues = wordsToCues(result.words)
    writeFileSync(wordsPath, `${JSON.stringify({ audio: audioPath, duration: result.duration, words: result.words }, null, 2)}\n`)
    writeFileSync(srtPath, formatSrt(cues))
    emit({ audio: audioPath, words: wordsPath, srt: srtPath, duration: Number(result.duration.toFixed(3)), cueCount: cues.length })
    return 0
  },

  /** Generate one still image with Seedream and download it. */
  async image(options) {
    const key = process.env.ARK_API_KEY
    if (typeof key !== 'string' || key === '') throw new Error('image: 环境变量 ARK_API_KEY 没有设置')
    if (typeof options.prompt !== 'string' || options.prompt === '') {
      throw new Error('image: --prompt "<画面描述>" is required')
    }
    const { DEFAULT_IMAGE_MODEL, generateImage } = await import('../core/ark.mjs')
    const result = await generateImage(
      { prompt: options.prompt, size: options.size, watermark: options.watermark },
      {
        apiKey: key,
        baseUrl: options.base ?? undefined,
        model: options.model ?? DEFAULT_IMAGE_MODEL,
        outDir: resolve(options.out ?? 'generated'),
        fileName: options.name,
        onProgress: (event) => {
          if (event.message !== undefined) console.error(`  ${event.phase}: ${event.message}`)
        },
      },
    )
    emit(result)
    return 0
  },

  /** List the image models this account can see. */
  async 'image-models'() {
    const key = process.env.ARK_API_KEY
    if (typeof key !== 'string' || key === '') throw new Error('image-models: 环境变量 ARK_API_KEY 没有设置')
    const { listModels } = await import('../core/ark.mjs')
    emit(await listModels({ apiKey: key, filter: 'seedream' }))
    return 0
  },

  /** Inspect one or more media files. */
  async probe(options) {
    const paths = options.paths ?? []
    if (paths.length === 0) throw new Error('probe: at least one path is required')
    const records = []
    for (const path of paths) records.push(await probe(resolve(path)))
    emit(records.length === 1 ? records[0] : records)
    return 0
  },

  /** Render one stage, or the whole chain with --all. */
  async render(options) {
    if (options.plan === undefined) throw new Error('render: --plan <plan.json> is required')
    const plan = loadResolvedPlan(options.plan)
    if (options.quality !== undefined) plan.quality = options.quality
    const { outDir, workDir } = renderDirs(plan, options)
    const onProgress = (event) => {
      if (event.phase === 'scene') console.error(`  scene ${event.sceneId}`)
    }

    if (options.all === true) {
      emit(await build(plan, { outDir, workDir, force: options.force === true, onProgress }))
      return 0
    }
    if (options.scene !== undefined) {
      const index = plan.scenes.findIndex((scene) => scene.id === options.scene)
      if (index < 0) throw new Error(`render: no scene with id ${options.scene}`)
      emit(await renderScene(plan.scenes[index], plan, index, { workDir, force: options.force === true }))
      return 0
    }
    if (options.assemble === true) {
      const clips = plan.scenes.map((scene, index) => clipPath(workDir, index, scene.id))
      emit(await assemble(clips, plan, { workDir, force: options.force === true }))
      return 0
    }
    if (options.finalize === true) {
      const timeline = join(workDir, 'timeline.mp4')
      emit(await finalize(timeline, plan, { workDir, outDir, force: options.force === true }))
      return 0
    }
    if (options.deliver === true) {
      emit(await deliver(join(outDir, 'final.mp4'), plan, { outDir }))
      return 0
    }
    throw new Error('render: choose one of --all, --scene <id>, --assemble, --finalize, --deliver')
  },

  /** Synthesize test material. */
  async 'make-test-material'(options) {
    if (options.dir === undefined) throw new Error('make-test-material: --dir <folder> is required')
    const result = await makeTestMaterial(resolve(options.dir), {
      sceneCount: options.scenes === undefined ? 6 : Number(options.scenes),
      seconds: options.seconds === undefined ? 12 : Number(options.seconds),
    })
    emit(result)
    return 0
  },
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(`video-factory — 确定性媒体工具

用法：node src/bin/vf.mjs <命令> [选项]

命令：
  doctor                             检查 ffmpeg / ffprobe、OCR 引擎与云端 Key
  install [--force]                  把 ffmpeg 装进 vendor/
  install-ocr [--source <id>] [--archive <本地.7z>] [--prune] [--force] [--remove]
                                     把离线 OCR 引擎装进 vendor/ocr/
  ocr <文件> [--region x,y,w,h] [--scale auto|<倍数>] [--engine auto|local|winrt]
             [--find "<文字>"] [--json]   读图片/视频里的文字，可定位并给出点击坐标
  install-audio [--force] [--remove]   把 YAMNet 模型与 WASM 运行时装进 vendor/audio/
  frames <视频> [--strategy adaptive|uniform|scene_change|motion_aware]
             [--probe-fps 4] [--scene-threshold 30] [--motion-threshold 5] [--json]
                                       自适应抽帧：找剪切点与运动，报出每帧的选中理由与分值
  audio <文件> [--start 秒] [--duration 秒] [--top-k 3] [--min-score 0.1] [--json]
                                       识别音轨里的声学事件（音乐/环境音/音效）与时间点
  install-matte [--force] [--archive <本地.onnx>] [--remove]
                                       把 U²-Net 抠图模型装进 vendor/matte/（运行时与 audio 共用）
  matte <图片|视频> [--at <秒>] [--feather <像素>] [--out <png>] [--keep-mask] [--json]
                                       抠出主体，输出透明背景 PNG（单帧约 2 秒）
  scan <目录> [--json] [--no-dedupe] 盘点素材
  fields                             打印 plan.json 字段速查
  check --plan <plan.json>           校验计划并报时长
  narrate --text <文案.txt> [--out <目录>] [--voice <音色>]
  probe <文件…>                      查看媒体流信息
  image --prompt "…" [--size 2k] [--out <目录>] [--name <文件名>] [--model <模型>]
  image-models                       列出可用的图像模型
  render --plan <plan.json> --all | --scene <id> | --assemble | --finalize | --deliver
  make-test-material --dir <目录> [--scenes 6] [--seconds 12]

没有"一键出片"命令：顺序编排是调用方的职责，这正是本插件的设计。`)
    return 0
  }

  const handler = COMMANDS[command]
  if (handler === undefined) {
    console.error(`未知命令：${command}（可用：${Object.keys(COMMANDS).join(', ')}）`)
    return 1
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      plan: { type: 'string' },
      out: { type: 'string' },
      work: { type: 'string' },
      text: { type: 'string' },
      voice: { type: 'string' },
      quality: { type: 'string' },
      scene: { type: 'string' },
      dir: { type: 'string' },
      scenes: { type: 'string' },
      seconds: { type: 'string' },
      prompt: { type: 'string' },
      size: { type: 'string' },
      name: { type: 'string' },
      model: { type: 'string' },
      base: { type: 'string' },
      source: { type: 'string' },
      archive: { type: 'string' },
      region: { type: 'string' },
      scale: { type: 'string' },
      engine: { type: 'string' },
      language: { type: 'string' },
      find: { type: 'string' },
      match: { type: 'string' },
      frames: { type: 'string' },
      'max-side': { type: 'string' },
      strategy: { type: 'string' },
      'probe-fps': { type: 'string' },
      'target-fps': { type: 'string' },
      'scene-threshold': { type: 'string' },
      'motion-threshold': { type: 'string' },
      'max-frames': { type: 'string' },
      start: { type: 'string' },
      duration: { type: 'string' },
      'top-k': { type: 'string' },
      'min-score': { type: 'string' },
      at: { type: 'string' },
      feather: { type: 'string' },
      'keep-mask': { type: 'boolean' },
      prune: { type: 'boolean' },
      remove: { type: 'boolean' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      watermark: { type: 'boolean' },
      all: { type: 'boolean' },
      assemble: { type: 'boolean' },
      finalize: { type: 'boolean' },
      deliver: { type: 'boolean' },
      'no-dedupe': { type: 'boolean' },
      'no-recursive': { type: 'boolean' },
    },
  })

  const options = { ...values }
  if (positionals.length > 0) {
    if (command === 'scan') options.path = positionals[0]
    else options.paths = positionals
  }

  try {
    return await handler(options)
  } catch (error) {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

process.exit(await main())
