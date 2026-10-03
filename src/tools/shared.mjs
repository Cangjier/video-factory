/**
 * Shared helpers for building the model-facing `video_*` tool definitions.
 *
 * Two rules shape everything here:
 *
 * 1. **The JSON Schema of every tool enters the model context on every turn.** So
 *    the surface is grouped by operation family with an `action` dispatcher rather
 *    than spread across ~30 flat tools. The cost is that each action's
 *    description must be self-explanatory, because the model is choosing among
 *    actions, not among tool names.
 *
 * 2. **A tool is a deterministic operation, never a pipeline.** Anything that
 *    encodes a creative choice (which scenes to use, how long they run, what
 *    order they go in) belongs to DSH, not to this plugin.
 *
 * @module video-factory/tools/shared
 */

/** Render any tool result as one pretty-printed JSON text block. */
export const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
  },
}

/** Shared `cwd` property: every path-taking tool resolves against it. */
export const CWD_PROPERTY = {
  type: 'string',
  description:
    'Working directory that relative paths resolve against. Defaults to the plugin project root, then the process working directory.',
}

/** Shared `force` property. */
export const FORCE_PROPERTY = {
  type: 'boolean',
  description: 'Ignore cached intermediates and redo the work even when the fingerprint matches.',
}

/**
 * Error type for a request this plugin refuses, with a message meant for the model.
 * Thrown errors surface as tool failures, so they must be actionable.
 */
export class VideoFactoryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VideoFactoryError'
  }
}

/**
 * Build one family tool.
 *
 * @param {object} spec - family definition.
 * @param {string} spec.name - tool name, for example `video_render`.
 * @param {string} spec.description - one-line purpose shown to the model.
 * @param {string} spec.actionsHelp - the per-action table, appended to the description.
 * @param {string[]} spec.actions - every legal `action` value.
 * @param {object} spec.extraProperties - additional JSON Schema properties.
 * @param {Record<string, (args: object, context: object) => Promise<object>>} spec.handlers -
 *   one implementation per action.
 * @returns {object} a raw tool definition suitable for `ctx.tools.register`.
 */
export function defineFamilyTool(spec) {
  const actions = [...spec.actions]

  return {
    name: spec.name,
    description: `${spec.description} Actions: ${actions.join(', ')}. ${spec.actionsHelp}`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: spec.actionsHelp,
        },
        ...spec.extraProperties,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, context) {
      const handler = spec.handlers[args?.action]
      if (handler === undefined) {
        throw new VideoFactoryError(
          `${spec.name}: unknown action ${JSON.stringify(args?.action)}; expected one of ${actions.join(', ')}`,
        )
      }
      // The host does not guarantee a second argument, so a missing or partial context
      // is normalized once here rather than defended against in every action.
      //
      // Anything the family needs from the host is resolved through `locate()` on every
      // call rather than captured at registration: the speech bundle can be enabled or
      // disabled while this plugin stays mounted, and a captured reference would go
      // stale. Everything located is optional — transcription is the only feature that
      // needs the speech service, and the rest must keep working without it.
      const located = typeof spec.locate === 'function' ? spec.locate() : {}
      const safeContext = {
        cwd: typeof context?.cwd === 'string' && context.cwd !== '' ? context.cwd : process.cwd(),
        ...located,
        ...context,
      }
      return handler(args ?? {}, safeContext)
    },
  }
}
