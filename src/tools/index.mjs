/**
 * Registers every model-facing `video_*` tool.
 *
 * The surface is deliberately small and grouped by job stage: each tool dispatches on an
 * `action`, because every schema enters the model context on every turn. What has changed is
 * where the detail lives — the resident schemas now carry only what the choice needs, and
 * `video_guide` renders the full reference (arguments, returns, cost, pitfalls, examples,
 * playbooks) on demand from the same registry the schemas are built from.
 *
 * The tool list itself comes from that registry, so a tool cannot be registered without
 * being documented, and cannot be documented without being registered.
 *
 * @module video-factory/tools
 */
import { createEnvTool } from './env.mjs'
import { createEnvActions } from './env-actions.mjs'
import { createSetupTool } from './setup.mjs'
import { createGuideTool } from './guide.mjs'
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
import { createAnalyzeTool } from './analyze.mjs'
import { createAnalyzeActions } from './analyze-actions.mjs'
import { createQcTool } from './qc.mjs'
import { createQcActions } from './qc-actions.mjs'
import { TOOL_ORDER } from './registry.mjs'

/** Every tool name this plugin registers, in the order the surface presents them. */
export const TOOL_NAMES = [...TOOL_ORDER]

/**
 * Build every tool definition.
 *
 * Each family pairs a schema module (what the model sees) with an actions module (what
 * actually runs). Keeping them apart means the schema can be read and reviewed on its
 * own, and that the deterministic core is never reachable except through an action.
 *
 * `video_guide` is built last and handed a thunk, because it is itself one of the tools it
 * documents: at construction time the list is incomplete, at call time it is not.
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

  const envActions = createEnvActions(config, logger)

  const definitions = [
    createEnvTool(envActions),
    createSetupTool(envActions),
    createPlanTool(createPlanActions(config, logger)),
    createNarrateTool(createNarrateActions(config, logger), locate),
    createAnalyzeTool(createAnalyzeActions(config, logger)),
    createGenTool(createGenActions(config, logger)),
    createRenderTool(createRenderActions(config, logger)),
    createInspectTool(createInspectActions(config, logger)),
    createQcTool(createQcActions(config, logger)),
  ]
  definitions.push(createGuideTool(() => definitions))

  const rank = (definition) => {
    const index = TOOL_ORDER.indexOf(definition.name)
    return index < 0 ? TOOL_ORDER.length : index
  }
  return definitions.sort((left, right) => rank(left) - rank(right))
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
