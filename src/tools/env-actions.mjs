/**
 * `video_env` actions.
 *
 * `probe` and `presets` are fully implemented because they only need environment
 * facts. `scan` waits for the materials module and says so explicitly rather than
 * returning an empty inventory, which would look like an empty folder.
 *
 * @module video-factory/tools/env-actions
 */
import { resolve } from 'node:path'
import { capabilitiesOf, findBinary, versionOf, vendoredBuild } from '../core/index.mjs'
import { InstallError, installFfmpeg, vendoredState } from '../core/install.mjs'
import { matteState } from '../core/matte.mjs'
import { installMatte, removeMatte, verifyInstalledMatte } from '../core/matte-install.mjs'
import {
  MaterialError,
  describe as describeInventory,
  inventoryToJson,
  scan as scanMaterials,
} from '../core/materials.mjs'
import { PRESETS } from '../core/plan.mjs'
import { VideoFactoryError } from './shared.mjs'

/**
 * Canvas presets are defined once, in the plan schema, and re-published here. Two
 * definitions would let the model and the renderer disagree about what a preset
 * means.
 */
export { PRESETS }


/**
 * Build the `video_env` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createEnvActions(config, logger) {
  return {
    /**
     * Report the environment the pipeline would run in.
     * @returns {Promise<object>} the environment report.
     */
    async probe() {
      const problems = []
      const ffmpegFound = findBinary('ffmpeg', config.ffmpegPath)
      const ffprobeFound = findBinary('ffprobe', config.ffprobePath)
      const ffmpeg = ffmpegFound?.path ?? null
      const ffprobe = ffprobeFound?.path ?? null

      const report = {
        ok: true,
        ffmpeg: ffmpeg === null ? { found: false } : { found: true, path: ffmpeg, source: ffmpegFound.source },
        ffprobe: ffprobe === null ? { found: false } : { found: true, path: ffprobe, source: ffprobeFound.source },
        vendored: vendoredBuild(),
        shared: vendoredBuild().shared,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        presets: Object.keys(PRESETS),
        ark: {
          baseUrl: config.ark.baseUrl,
          apiKeyEnv: config.ark.apiKeyEnv,
          keyPresent: typeof process.env[config.ark.apiKeyEnv] === 'string' && process.env[config.ark.apiKeyEnv] !== '',
          defaultModel: config.ark.defaultModel,
        },
        tts: {
          provider: 'edge',
          voice: config.tts.voice,
          // Edge TTS needs no key. Reachability is proven by actually synthesizing,
          // which is what video_narrate does, so this is a configuration fact only.
          requiresKey: false,
        },
        pathBudget: config.pathBudget,
        // Optional model, reported as a fact rather than as a problem: the plugin works without
        // it, and a missing model only disables the action that needs it. The runtime it shares
        // with audio event detection lives in another plugin now, so this says where it was found
        // — including "nowhere" — rather than reporting a capability that is not this plugin's.
        matte: matteState(),
      }

      if (ffmpeg === null) {
        problems.push(
          `找不到 ffmpeg。请设置 DSH_FFMPEG（或 VIDEO_FACTORY_FFMPEG），或把构建放进共享目录 ${vendoredBuild().shared.sharedRoot}/ffmpeg/bin，` +
            '或让它出现在 PATH 里；也可以运行 video_setup {action:"install_ffmpeg"} 装一份。',
        )
      }
      if (ffprobe === null) {
        problems.push('找不到 ffprobe。两者必须成对可用：装配阶段依赖 ffprobe 检查流信息。')
      }
      if (ffmpeg !== null) {
        report.ffmpeg.version = await versionOf(ffmpeg)
        const capabilities = await capabilitiesOf(ffmpeg)
        report.ffmpeg.encoders = capabilities.encoders
        report.ffmpeg.filters = capabilities.filters
        const missingEncoders = ['libx264', 'aac'].filter((name) => !capabilities.encoders.includes(name))
        const missingFilters = ['zoompan', 'xfade', 'loudnorm', 'subtitles'].filter((name) => !capabilities.filters.includes(name))
        if (missingEncoders.length > 0) problems.push(`ffmpeg 缺少必需的编码器：${missingEncoders.join(', ')}`)
        if (missingFilters.length > 0) problems.push(`ffmpeg 缺少必需的滤镜：${missingFilters.join(', ')}`)
      }
      if (ffprobe !== null) report.ffprobe.version = await versionOf(ffprobe)

      /*
       * Desktop automation used to be reported here: the input transports, the pointer canary and the
       * screen coordinates. It is a plugin of its own now (`dsh-computer-use`), which is why calling
       * this probe no longer moves the user's pointer as a side effect. Text recognition left the same
       * way and is now `dsh-ocr` (`text_*`). Audio event detection and everything else about sound
       * left for `dsh-video-audio` (`audio_*`), so `audio` is no longer a key here: ask
       * `audio_setup {action:"status"}` instead. What is left is what a video pipeline needs —
       * ffmpeg, the matting model and its borrowed runtime, and the cloud key.
       */

      if (!report.ark.keyPresent) {
        report.notes = [
          `未设置 ${config.ark.apiKeyEnv}，云端生成镜头不可用；本地剪辑、配音、字幕全部照常工作。`,
        ]
      }

      report.problems = problems
      report.ok = problems.length === 0
      if (!report.ok) logger.warn(`video-factory: 环境自检发现 ${problems.length} 个问题`)
      return report
    },

    /**
     * List the canvas presets.
     * @returns {object} the preset table.
     */
    presets() {
      return { presets: PRESETS }
    },

    /**
     * Report or provision the vendored ffmpeg build.
     *
     * Downloading is the only way to make a fresh machine work, and it is much cheaper
     * to trigger from here than to explain the manual steps.
     * @param {object} args - the request.
     * @returns {Promise<object>} the installation state.
     */
    async install_ffmpeg(args) {
      const before = vendoredState()
      if (before.present && args.force !== true) {
        return { installed: false, reason: '已存在可用的 vendored 构建', ...before }
      }
      try {
        const result = await installFfmpeg({
          force: args.force === true,
          onProgress: (line) => logger.info(`video-factory install: ${line}`),
        })
        return { ...result, state: vendoredState() }
      } catch (error) {
        if (error instanceof InstallError) throw new VideoFactoryError(`安装 ffmpeg 失败：${error.message}`)
        throw error
      }
    },

    /**
     * Inventory a material folder.
     * @param {object} args - the request.
     * @param {object} context - the tool context, supplying `cwd`.
     * @returns {Promise<object>} the inventory.
     */
    async scan(args, context) {
      if (typeof args.root !== 'string' || args.root.trim() === '') {
        throw new VideoFactoryError('video_env: action "scan" needs "root" — the material folder to inventory.')
      }
      const root = resolve(context.cwd, args.root)
      try {
        const inventory = await scanMaterials(root, {
          recursive: args.recursive !== false,
          dedupe: args.dedupe !== false,
          config,
        })
        return { ...inventoryToJson(inventory), summary: describeInventory(inventory) }
      } catch (error) {
        if (error instanceof MaterialError) throw new VideoFactoryError(`video_env scan: ${error.message}`)
        throw error
      }
    },

    /**
     * Provision the matting model.
     *
     * Only the 4.36 MB model: the inference runtime it shares with audio event detection is
     * installed by `install_audio`, and `matteState` says so when it is missing rather than
     * fetching a second copy of the same 13 MB.
     *
     * @param {object} args - the request.
     * @returns {Promise<object>} the installation state.
     */
    async install_matte(args) {
      if (args.remove === true) {
        const result = removeMatte({ onProgress: (line) => logger.info(`video-factory install_matte: ${line}`) })
        return {
          removed: result.removed,
          directory: result.directory,
          keptRuntime: result.keptRuntime,
          reason: result.removed ? '已删除（共享运行时保留）' : '本来就没有安装',
          state: matteState(),
        }
      }

      try {
        const result = await installMatte({
          force: args.force === true,
          modelArchive: typeof args.archive === 'string' && args.archive !== '' ? resolve(args.archive) : undefined,
          onProgress: (line) => logger.info(`video-factory install_matte: ${line}`),
        })
        return { ...result, state: matteState(), verify: verifyInstalledMatte() }
      } catch (error) {
        throw new VideoFactoryError(`安装抠图模型失败：${error.message}`)
      }
    },
  }
}
