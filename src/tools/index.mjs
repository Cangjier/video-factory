/**
 * Registers every model-facing `video_*` tool.
 *
 * The tool surface is deliberately small: seven families, each dispatching on an
 * `action`. Every tool schema enters the model context on every turn, so ~30 flat
 * tools would cost several times the tokens of these seven for the same reach.
 *
 * @module video-factory/tools
 */
import { createEnvTool } from './env.mjs'
import { createEnvActions } from './env-actions.mjs'
import { createNarrateTool } from './narrate.mjs'
import { createNarrateActions } from './narrate-actions.mjs'
import { createPlanTool } from './plan.mjs'
import { createPlanActions } from './plan-actions.mjs'
import { createRenderTool } from './render.mjs'
import { createRenderActions } from './render-actions.mjs'
import { createInspectTool } from './inspect.mjs'
import { createInspectActions } from './inspect-actions.mjs'
import { createGenTool } from './gen.mjs'
import { createGenActions } from './gen-actions.mjs'

/** Every tool name this plugin registers. */
export const TOOL_NAMES = ['video_env', 'video_narrate', 'video_plan', 'video_render', 'video_inspect', 'video_gen']

/**
 * Build every tool definition.
 *
 * Each family pairs a schema module (what the model sees) with an actions module (what
 * actually runs). Keeping them apart means the schema can be read and reviewed on its
 * own, and that the deterministic core is never reachable except through an action.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @param {object} [host] - optional access to host services.
 * @param {() => object} [host.getService] - resolves a service by name at call time.
 * @returns {object[]} raw tool definitions.
 */
export function toolDefinitions(config, logger, host = {}) {
  const getService = host.getService ?? (() => undefined)
  // Only transcription needs a host service, and it is resolved per call so enabling or
  // disabling the speech bundle while this plugin stays mounted takes effect at once.
  const locate = () => ({ speechToText: getService('speechToText') })

  return [
    createEnvTool(createEnvActions(config, logger)),
    createNarrateTool(createNarrateActions(config, logger), locate),
    createPlanTool(createPlanActions(config, logger)),
    createRenderTool(createRenderActions(config, logger)),
    createInspectTool(createInspectActions(config, logger)),
    createGenTool(createGenActions(config, logger)),
  ]
}

/**
 * Register every tool on a context that already carries the `tools` service.
 *
 * A failing registration must not take the whole plugin down: the others are still
 * useful, and the failure is reported to the log.
 *
 * @param {object} toolsCtx - the sub-context providing `tools`.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @param {object} [host] - optional host service access, forwarded to the definitions.
 * @returns {{registered: string[], failed: {name: string, error: string}[]}} the outcome.
 */
export function registerTools(toolsCtx, config, logger, host = {}) {
  const registered = []
  const failed = []
  for (const definition of toolDefinitions(config, logger, host)) {
    try {
      toolsCtx.tools.register(definition)
      registered.push(definition.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ name: definition.name, error: message })
      logger.error(`video-factory: 注册工具 ${definition.name} 失败：${message}`)
    }
  }
  logger.info(`video-factory: 已注册 ${registered.length} 个工具：${registered.join(', ')}`)
  return { registered, failed }
}
