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
import { resolveBinary, capabilitiesOf, versionOf, vendoredBuild } from '../core/index.mjs'
import { InstallError, installFfmpeg, vendoredState } from '../core/install.mjs'
import {
  MaterialError,
  describe as describeInventory,
  inventoryToJson,
  scan as scanMaterials,
} from '../core/materials.mjs'
import { PRESETS } from '../core/plan.mjs'
import {
  INPUT_TRANSPORTS,
  TRANSPORT_PREFERENCE,
  driverAvailable,
  verifyVirtualHidInput,
  virtualKeyboardAvailable,
  virtualMouseAvailable,
} from '../core/automation.mjs'
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
      const ffmpeg = resolveBinary('ffmpeg', config.ffmpegPath)
      const ffprobe = resolveBinary('ffprobe', config.ffprobePath)

      const report = {
        ok: true,
        ffmpeg: ffmpeg === null ? { found: false } : { found: true, path: ffmpeg },
        ffprobe: ffprobe === null ? { found: false } : { found: true, path: ffprobe },
        vendored: vendoredBuild(),
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
      }

      if (ffmpeg === null) {
        problems.push('找不到 ffmpeg。请设置 VIDEO_FACTORY_FFMPEG，或把它放到 vendor/ffmpeg/bin/，或让它出现在 PATH 里。')
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
       * Input transports, reported because they decide whether this machine can drive a browser or an
       * application at all, and because the answer differs from machine to machine.
       *
       * `virtualkbd` is a real HID device created by our own driver, and it is the one to prefer: being a
       * device, nothing above the HID layer can treat its input as synthetic. `driver` is the Interception
       * filter, which is present here but whose keyboard path silently delivers nothing on this virtual
       * machine. `sendinput` always works and needs no installation.
       *
       * Each is probed rather than assumed — the files being present says nothing about whether the driver
       * actually started.
       */
      // The devices are verified, not merely opened: a virtual HID device can be present, bound and accepting
      // reports while the system declines to act on them, so "the client could open it" is not an answer. The
      // pointer is the canary because it can be checked and a keystroke cannot; the check moves it a little
      // and puts it back.
      const virtualHid = await verifyVirtualHidInput()
      const virtualKeyboard = await virtualKeyboardAvailable()
      const virtualMouse = await virtualMouseAvailable()
      const filter = await driverAvailable()
      report.virtualHidVerified = {
        works: virtualHid.works,
        detail: virtualHid.works
          ? '虚拟 HID 设备已实际验证：指针按要求移动到位。'
          : `虚拟 HID 设备存在并接受报告，但系统未对其作出反应，因此判定为不可用：${virtualHid.reason}`,
      }
      report.input = {
        transports: INPUT_TRANSPORTS,
        preference: TRANSPORT_PREFERENCE,
        virtualKeyboard: {
          available: virtualKeyboard.available,
          reason: virtualKeyboard.reason,
          note: '自研 VHF 虚拟 HID 键盘；作为真实设备进入输入栈，应用无法与物理键盘区分。',
        },
        virtualMouse: {
          available: virtualMouse.available,
          reason: virtualMouse.reason,
          note:
            '自研 VHF 虚拟 HID 鼠标；绝对定位，实测误差不超过 1 像素，左右键与滚轮均可用。' +
            '「可用」是经实际移动指针验证的结论，不是仅凭能否打开设备得出的。',
        },
        filterDriver: {
          available: filter.available,
          reason: filter.reason,
          note: 'Interception 过滤驱动。本机鼠标可用，键盘路径静默无效（虚拟机的模拟 PS/2 键盘）。',
        },
        sendInput: { available: true, note: 'Win32 SendInput；无需安装，始终可用。' },
      }
      if (!virtualKeyboard.available || !virtualMouse.available) {
        const missing = [
          virtualKeyboard.available ? null : '键盘',
          virtualMouse.available ? null : '鼠标',
        ].filter(Boolean).join('与')
        report.notes = [
          ...(report.notes ?? []),
          `虚拟 HID ${missing}不可用。输入将回退到 Interception 或 SendInput。` +
            '安装方式：先运行 components/vhfkey/build.ps1，再运行 components/vhfkey/install-run.ps1。',
        ]
      }

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
  }
}
