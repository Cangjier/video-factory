/**
 * `video_gen` actions: discovering what this account can generate, and generating it.
 *
 * `models` and `image_models` read the provider's own model listing rather than a
 * hard-coded table, because model ids carry dated suffixes that go stale and a shut-down
 * id is rejected outright. Both generators finish the job — produce, then download —
 * because the result URL is a presigned link that expires in 24 hours, so handing a URL
 * back to the caller risks losing the asset entirely.
 *
 * Video answers asynchronously and is polled; images answer synchronously. That difference
 * is the only structural one between `generate` and `image`.
 *
 * @module video-factory/tools/gen-actions
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ArkError,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MAX_PIXELS,
  IMAGE_MIN_PIXELS,
  generate as arkGenerate,
  generateImage,
  listModels,
} from '../core/ark.mjs'
import { VideoFactoryError } from './shared.mjs'

/**
 * Read the API key from the configured environment variable.
 * @param {object} config - normalized plugin config.
 * @returns {string} the key.
 * @throws {VideoFactoryError} when it is not set.
 */
function apiKeyFrom(config) {
  const value = process.env[config.ark.apiKeyEnv]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VideoFactoryError(
      `video_gen: 环境变量 ${config.ark.apiKeyEnv} 没有设置，云端生成不可用。` +
        '本地剪辑、配音、字幕不受影响；需要生成镜头时请先配置该环境变量并重启 DSH。',
    )
  }
  return value
}

/**
 * Build the `video_gen` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createGenActions(config, logger) {
  return {
    /**
     * List the Seedance models this account can see, with their availability.
     * @returns {Promise<object>} the model table.
     */
    async models() {
      const apiKey = apiKeyFrom(config)
      try {
        const result = await listModels({ apiKey, baseUrl: config.ark.baseUrl })
        const live = result.models.filter((model) => model.availability === 'live')
        return {
          total: result.total,
          scanned: result.scanned ?? null,
          live: live.map((model) => model.id),
          models: result.models,
          recommended: config.ark.defaultModel ?? live[0]?.id ?? null,
          note:
            'availability 为 live 表示在售（未开通时创建任务会返回 ModelNotOpen，需要去方舟控制台激活）；' +
            'retiring 表示退役中；shutdown 表示已下线，不要使用。',
        }
      } catch (error) {
        if (error instanceof ArkError) throw new VideoFactoryError(`读取模型列表失败：${error.message}`)
        throw error
      }
    },

    /**
     * List the Seedream image models this account can see, with their availability.
     *
     * Reads the same catalogue as `models` with a different filter, so both follow the
     * provider rather than a table that rots.
     * @returns {Promise<object>} the image model table.
     */
    async image_models() {
      const apiKey = apiKeyFrom(config)
      try {
        const result = await listModels({ apiKey, baseUrl: config.ark.baseUrl, filter: 'seedream' })
        const live = result.models.filter((model) => model.availability === 'live')
        return {
          total: result.total,
          scanned: result.scanned ?? null,
          live: live.map((model) => model.id),
          models: result.models,
          recommended: config.ark.imageModel ?? DEFAULT_IMAGE_MODEL,
          limits: {
            minPixels: IMAGE_MIN_PIXELS,
            maxPixels: IMAGE_MAX_PIXELS,
            note: '图像面积必须落在这个区间；越界会在花钱之前就被本地拒绝。',
          },
          note:
            'availability 为 live 表示在售（未开通会返回 ModelNotOpen，需要去方舟控制台激活）。' +
            '注意 seededit 与早期 seedream 多为 Shutdown，不要使用。',
        }
      } catch (error) {
        if (error instanceof ArkError) throw new VideoFactoryError(`读取图像模型列表失败：${error.message}`)
        throw error
      }
    },

    /**
     * Generate one still image and download it.
     *
     * Unlike video this is synchronous, so there is no polling and no progress stream —
     * it either returns a path in a few seconds or fails.
     *
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the local path and what the provider reported.
     */
    async image(args, context) {
      const apiKey = apiKeyFrom(config)
      // `imagePrompt` exists so a plan can carry a video prompt and an image prompt at once
      // without the two colliding on one field name.
      const prompt = typeof args.imagePrompt === 'string' && args.imagePrompt !== '' ? args.imagePrompt : args.prompt
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        throw new VideoFactoryError('video_gen image: 需要 "prompt"（或 "imagePrompt"）。')
      }
      if (args.imageCount !== undefined && args.imageCount !== 1) {
        throw new VideoFactoryError(
          'video_gen image: 当前模型每次请求只返回一张图，"imageCount" 只能是 1。要更多请多次调用。',
        )
      }

      const outDir =
        typeof args.outDir === 'string' && args.outDir !== ''
          ? resolve(context.cwd, args.outDir)
          : resolve(context.cwd, 'generated')
      mkdirSync(outDir, { recursive: true })

      const model = args.imageModel ?? config.ark.imageModel ?? DEFAULT_IMAGE_MODEL
      logger.info(`video-factory: 生成图像 ${model} ${args.imageSize ?? '(默认尺寸)'}`)

      try {
        const result = await generateImage(
          { model, prompt, size: args.imageSize, watermark: args.watermark, seed: args.seed },
          {
            apiKey,
            baseUrl: config.ark.baseUrl,
            outDir,
            fileName: args.sceneId === undefined ? undefined : `${args.sceneId}.png`,
            onProgress: (event) => {
              if (event.phase === 'generating') logger.info(`video-factory: 已提交图像生成`)
              else if (event.phase === 'downloading') logger.info('video-factory: 正在下载图像')
              else if (event.phase === 'warning') logger.warn(`video-factory: ${event.message}`)
            },
          },
        )
        logger.info(`video-factory: 落盘 ${result.localPath}`)

        // A generated still is a normal image file, so its real dimensions come from
        // probing it rather than from the provider's claim.
        const { probe } = await import('../core/probe.mjs')
        const info = await probe(result.localPath, config)
        return {
          ...result,
          width: info.width,
          height: info.height,
          bytes: info.sizeBytes,
          planFragment: { kind: 'image', source: result.localPath },
          note:
            '这是本地图片文件，不是厂商 URL（URL 24 小时过期）。可以直接作为 plan.json 里某个镜头的 source。' +
            (args.watermark === false
              ? '注意：已关闭厂商水印，公开发布前请自行添加 AI 生成内容标识。'
              : ''),
        }
      } catch (error) {
        if (error instanceof ArkError) throw new VideoFactoryError(`图像生成失败：${error.message}`)
        throw error
      }
    },

    /**
     * Generate one clip and download it.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the local path and the provider's final response.
     */
    async generate(args, context) {
      const apiKey = apiKeyFrom(config)
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new VideoFactoryError('video_gen generate: 需要 "prompt"。')
      }

      const mode = args.mode ?? (args.lastFrame !== undefined ? 'first-last-frame' : args.reference !== undefined ? 'image-to-video' : 'text-to-video')
      if (mode !== 'text-to-video' && (typeof args.reference !== 'string' || args.reference === '')) {
        throw new VideoFactoryError(`video_gen generate: 模式 "${mode}" 需要 "reference"（首帧图片路径或公网 URL）。`)
      }
      if (mode === 'first-last-frame' && (typeof args.lastFrame !== 'string' || args.lastFrame === '')) {
        throw new VideoFactoryError('video_gen generate: 模式 "first-last-frame" 需要 "lastFrame"。')
      }

      const outDir =
        typeof args.outDir === 'string' && args.outDir !== ''
          ? resolve(context.cwd, args.outDir)
          : join(context.cwd, 'generated')
      mkdirSync(outDir, { recursive: true })

      const spec = {
        model: args.model ?? config.ark.defaultModel ?? undefined,
        mode,
        prompt: args.prompt,
        reference: args.reference === undefined ? null : resolve(context.cwd, args.reference),
        lastFrame: args.lastFrame === undefined ? null : resolve(context.cwd, args.lastFrame),
        duration: args.duration,
        resolution: args.resolution,
        ratio: args.ratio,
        seed: args.seed,
        watermark: args.watermark,
        cameraFixed: args.cameraFixed,
        generateAudio: args.generateAudio,
        draft: args.draft,
        returnLastFrame: args.returnLastFrame,
        serviceTier: args.serviceTier,
        sceneId: args.sceneId,
      }

      const pollInterval = args.pollIntervalSeconds ?? config.ark.pollIntervalSeconds
      const maxWait = args.maxWaitSeconds ?? config.ark.maxWaitSeconds
      logger.info(`video-factory: 提交生成任务（${mode}，${args.duration ?? '默认'}s，${args.resolution ?? '默认'}）`)

      try {
        const result = await arkGenerate(spec, {
          apiKey,
          baseUrl: config.ark.baseUrl,
          outDir,
          fileName: args.sceneId === undefined ? undefined : `${args.sceneId}.mp4`,
          pollIntervalSeconds: pollInterval,
          maxWaitSeconds: maxWait,
          onProgress: (event) => {
            if (event.phase === 'submitted') logger.info(`video-factory: 任务已提交 ${event.message ?? ''}`)
            else if (event.phase === 'polling') {
              logger.info(`video-factory: 生成中 status=${event.state} 已等待 ${event.elapsedSeconds}s（第 ${event.attempt} 次轮询）`)
            } else if (event.phase === 'downloading') logger.info('video-factory: 生成完成，正在下载')
          },
        })
        logger.info(`video-factory: 落盘 ${result.localPath}`)
        return {
          ...result,
          note:
            '生成结果是本地文件，不是厂商 URL（URL 24 小时过期）。' +
            (args.watermark === false
              ? '注意：已关闭厂商水印，公开发布前请自行添加 AI 生成内容标识（《人工智能生成合成内容标识办法》要求显式+隐式标识）。'
              : ''),
        }
      } catch (error) {
        if (error instanceof ArkError) throw new VideoFactoryError(`生成失败：${error.message}`)
        throw error
      }
    },
  }
}
