/**
 * `video_guide` — the on-demand reference for everything this plugin can do.
 *
 * Why a tool rather than more prose in each schema: every sentence in a tool schema is paid
 * for on every turn, so the resident surface can only carry what the choice itself needs.
 * The long tail — every argument with its meaning and default, return shapes, cost, the
 * pitfalls that keep repeating, runnable examples, the recommended order for a job — is
 * worth much more when it is read once, on purpose, than when it is resident and skimmed.
 *
 * It is rendered from `registry.mjs` (the same source the schemas are built from) and from
 * `playbook.mjs` (the cross-cutting rules and recipes), plus the live parameter schemas, so
 * it cannot describe a surface that no longer exists.
 *
 * @module video-factory/tools/guide
 */
import { CWD_PROPERTY, VideoFactoryError, defineFamilyTool } from './shared.mjs'
import { REGISTRY, TOOL_ORDER, lookupAction, lookupTool } from './registry.mjs'
import { GLOBAL_RULES, PLAYBOOKS } from './playbook.mjs'

export const GUIDE_TOOL_NAME = 'video_guide'

/** Every action this family exposes, in dispatch order. */
export const GUIDE_ACTIONS = ['overview', 'playbook', 'rules', 'tool', 'action']

/** The reference takes one argument naming a tool, and one naming an action. */
const GUIDE_PROPERTIES = {
  tool: {
    type: 'string',
    enum: TOOL_ORDER,
    description:
      'overview / tool / action: which tool to describe. For "action" this is the family the action belongs to.',
  },
  name: {
    type: 'string',
    description:
      'action: the action to describe in full, for example "scene" or "levels". It goes here, not in "action" — "action" selects this reference action.',
  },
  job: {
    type: 'string',
    enum: Object.keys(PLAYBOOKS),
    description: 'playbook: which recipe to expand. Omit it to list the recipes and what each is for.',
  },
  cwd: CWD_PROPERTY,
}

/**
 * Render one action's full entry as markdown.
 *
 * @param {string} tool - tool name.
 * @param {string} action - action name.
 * @param {object} entry - the registry entry for that action.
 * @returns {string} markdown.
 */
function renderAction(tool, action, entry) {
  const lines = [`### ${tool} {action:"${action}"}`, '', entry.summary, '']
  lines.push(`- **Use**: ${entry.use}`)
  if (entry.avoid) lines.push(`- **Avoid**: ${entry.avoid}`)
  lines.push(`- **Requires**: ${entry.required.length > 0 ? entry.required.join(', ') : 'nothing beyond "action"'}`)
  lines.push(`- **Returns**: ${entry.returns}`)
  lines.push(`- **Cost**: ${entry.cost}`)
  lines.push(`- **Example**: \`${JSON.stringify(entry.example)}\``)
  if (entry.seeAlso.length > 0) lines.push(`- **Goes with**: ${entry.seeAlso.join(', ')}`)
  if (entry.gotchas.length > 0) {
    lines.push('- **Pitfalls**:')
    for (const gotcha of entry.gotchas) lines.push(`  - ${gotcha}`)
  }
  return lines.join('\n')
}

/**
 * Attribute every declared parameter to the actions whose description names it.
 *
 * Parameter descriptions are written as `"action / action: meaning"`, which is what lets the
 * reference say which arguments an action actually reads without a second registry to keep in
 * sync.
 *
 * @param {object} definition - the live tool definition.
 * @param {string[]} actions - the tool's actions.
 * @returns {{ usedBy: string[]|null, name: string, schema: object }[]} parameters in schema order.
 */
function attributeParameters(definition, actions) {
  const properties = definition?.parameters?.properties ?? {}
  const rows = []
  for (const [name, schema] of Object.entries(properties)) {
    if (name === 'action') continue
    const description = typeof schema?.description === 'string' ? schema.description : ''
    const match = /^([a-z_]+(?: \/ [a-z_]+)*): /.exec(description)
    let usedBy = null
    if (match !== null) {
      const candidates = match[1].split(' / ')
      if (candidates.every((candidate) => actions.includes(candidate))) usedBy = candidates
    }
    rows.push({ name, schema, usedBy })
  }
  return rows
}

/**
 * Render one tool in full, including the parameter reference the schema only implies.
 *
 * @param {object} definition - the live tool definition.
 * @param {object} entry - the registry entry for the tool.
 * @returns {string} markdown.
 */
function renderTool(definition, entry) {
  const actions = definition.parameters.properties.action.enum
  const lines = [
    `## ${definition.name}`,
    '',
    entry.purpose,
    '',
    `- **Use it when**: ${entry.use.join('; ')}`,
    `- **Do not use it for**: ${entry.avoid.join('; ')}`,
    `- **Needs**: ${entry.needs.join(' ')}`,
    `- **Next**: ${entry.next.join(' ')}`,
    '',
    '### Arguments',
    '',
    '| argument | type | required by | meaning |',
    '| --- | --- | --- | --- |',
  ]

  const parameters = attributeParameters(definition, actions)
  for (const { name, schema, usedBy } of parameters) {
    const requiredBy = actions.filter((action) => {
      const actionEntry = entry.actions[action]
      return actionEntry.required.some((requirement) => requirement.includes(name))
    })
    const type = Array.isArray(schema.type) ? schema.type.join(' \\| ') : (schema.type ?? 'any')
    const meaning = typeof schema.description === 'string' ? schema.description.replace(/\|/g, '\\|') : ''
    const scope = requiredBy.length > 0 ? `${requiredBy.join(', ')} (required)` : usedBy === null ? 'shared' : usedBy.join(', ')
    lines.push(`| \`${name}\` | ${type} | ${scope} | ${meaning} |`)
  }

  lines.push('', '### Actions', '')
  for (const action of actions) {
    lines.push(renderAction(definition.name, action, entry.actions[action]))
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render every tool and action as one index.
 *
 * @param {object[]} definitions - every live tool definition, in surface order.
 * @returns {string} markdown.
 */
function renderOverview(definitions) {
  const lines = [
    '# video-factory: what this plugin can do',
    '',
    'It executes; you decide. Nothing here chooses scenes, order, pacing or wording, and there is no one-shot "make me a video" action — sequencing the calls is your job. `video_guide {action:"playbook"}` gives the recommended order for the common jobs, and `video_guide {action:"rules"}` the rules that apply to all of them.',
    '',
  ]
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  for (const name of TOOL_ORDER) {
    const definition = byName.get(name)
    const entry = lookupTool(name)
    if (definition === undefined || entry === undefined) continue
    lines.push(`## ${name}`, '', entry.purpose, '', `Needs: ${entry.needs.join(' ')}`, '')
    for (const action of definition.parameters.properties.action.enum) {
      const actionEntry = entry.actions[action]
      const requires = actionEntry.required.length > 0 ? ` _(requires: ${actionEntry.required.join(', ')})_` : ''
      lines.push(`- \`${action}\`${requires} — ${actionEntry.summary}`)
    }
    lines.push('', `Full detail: \`video_guide {action:"tool", tool:"${name}"}\`.`, '')
  }
  return lines.join('\n')
}

/** Render the cross-cutting rules. */
function renderRules() {
  const lines = ['# Rules that apply to every job', '']
  const headings = {
    divisionOfLabour: 'Who decides what',
    doNotHandRoll: 'What not to build yourself',
    determinism: 'Determinism',
    caching: 'Caching and force',
    generation: 'Generated material',
    planAuthoring: 'Writing plan.json',
    costAndAvailability: 'Cost, keys and installs',
    qualityGates: 'Quality gates',
    outputVisibility: 'What you actually see back',
    troubleshooting: 'Symptom to action',
  }
  for (const [key, heading] of Object.entries(headings)) {
    const items = GLOBAL_RULES[key]
    if (items === undefined) continue
    lines.push(`## ${heading}`, '')
    for (const item of items) lines.push(`- ${item}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render one playbook, or the list of them.
 *
 * @param {string|undefined} job - the recipe id.
 * @returns {string} markdown.
 */
function renderPlaybook(job) {
  if (job === undefined) {
    const lines = ['# Recipes', '', 'Ordered steps for the jobs this plugin is actually used for. A recipe fixes the order of the tool calls; the creative decisions inside each step are still yours.', '']
    for (const [id, recipe] of Object.entries(PLAYBOOKS)) {
      lines.push(`- \`${id}\` — ${recipe.title}. ${recipe.when}`)
    }
    lines.push('', 'Read one with `video_guide {action:"playbook", job:"<id>"}`.')
    return lines.join('\n')
  }
  const recipe = PLAYBOOKS[job]
  if (recipe === undefined) {
    throw new VideoFactoryError(
      `video_guide playbook: unknown job ${JSON.stringify(job)}; expected one of ${Object.keys(PLAYBOOKS).join(', ')}`,
    )
  }
  const lines = [`# ${recipe.title}`, '', `**Goal**: ${recipe.goal}`, '', `**When**: ${recipe.when}`, '', '## Steps', '']
  recipe.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`))
  lines.push('', '## What goes wrong', '')
  for (const pitfall of recipe.pitfalls) lines.push(`- ${pitfall}`)
  return lines.join('\n')
}

/**
 * Build the `video_guide` tool definition.
 *
 * @param {() => object[]} getDefinitions - returns every live tool definition. It is a thunk
 *   because the guide is itself one of them: at construction time the list is incomplete, at
 *   call time it is not.
 * @returns {object} the tool definition.
 */
export function createGuideTool(getDefinitions) {
  const find = (name, action) => {
    if (typeof name !== 'string' || name === '') {
      throw new VideoFactoryError(
        `video_guide ${action}: 需要 "tool"（可用：${TOOL_ORDER.join(', ')}）。`,
      )
    }
    const definition = getDefinitions().find((entry) => entry.name === name)
    const entry = lookupTool(name)
    if (definition === undefined || entry === undefined) {
      throw new VideoFactoryError(`video_guide ${action}: 未知的工具 ${JSON.stringify(name)}（可用：${TOOL_ORDER.join(', ')}）。`)
    }
    return { definition, entry }
  }

  return defineFamilyTool({
    name: GUIDE_TOOL_NAME,
    actions: GUIDE_ACTIONS,
    extraProperties: GUIDE_PROPERTIES,
    handlers: {
      async overview() {
        return { action: 'overview', text: renderOverview(getDefinitions()) }
      },
      async rules() {
        return { action: 'rules', text: renderRules() }
      },
      async playbook(args) {
        const job = typeof args.job === 'string' && args.job !== '' ? args.job : undefined
        return { action: 'playbook', job: job ?? null, text: renderPlaybook(job) }
      },
      async tool(args) {
        const { definition, entry } = find(args.tool, 'tool')
        return { action: 'tool', tool: definition.name, text: renderTool(definition, entry) }
      },
      async action(args) {
        const { definition } = find(args.tool, 'action')
        const name = args.name
        if (typeof name !== 'string' || name === '') {
          throw new VideoFactoryError(`video_guide action: 需要 "name"（${args.tool} 可用：${definition.parameters.properties.action.enum.join(', ')}）。`)
        }
        const entry = lookupAction(args.tool, name)
        if (entry === undefined) {
          throw new VideoFactoryError(
            `video_guide action: ${args.tool} 没有动作 ${JSON.stringify(name)}（可用：${definition.parameters.properties.action.enum.join(', ')}）。`,
          )
        }
        const toolEntry = lookupTool(args.tool)
        const header = [`# ${args.tool} {action:"${name}"}`, '', toolEntry.purpose, ''].join('\n')
        return { action: 'action', tool: args.tool, name, text: `${header}\n${renderAction(args.tool, name, entry)}` }
      },
    },
  })
}

/** Every tool documented here, for the tests and for callers that want the list. */
export const GUIDE_TOOL_NAMES = TOOL_ORDER

/** The registry, re-exported so a caller can reason about the surface without importing it twice. */
export const GUIDE_REGISTRY = REGISTRY
