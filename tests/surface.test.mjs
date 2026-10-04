/**
 * The invariants of the model-facing surface.
 *
 * These tests exist because the surface is a budget: every sentence in a tool schema is paid
 * for on every turn, and the detail that does not fit there has to stay reachable. So the
 * things worth guarding are not "does it work" but:
 *
 *   - the registry and the registered tools describe the same thing, in both directions;
 *   - no sentence is paid for twice inside one schema;
 *   - every action is named in the text that describes the enum;
 *   - the resident surface stays inside a byte budget, so prose growth fails loudly;
 *   - `video_guide` can answer for every tool and every action, and refuses the rest usefully.
 *
 * @module video-factory/test/surface
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { TOOL_NAMES, toolDefinitions } from '../src/tools/index.mjs'
import { REGISTRY, TOOL_ORDER, lookupAction, lookupTool } from '../src/tools/registry.mjs'
import { GLOBAL_RULES, PLAYBOOKS } from '../src/tools/playbook.mjs'

const logger = { info() {}, warn() {}, error() {}, debug() {} }
const definitions = toolDefinitions({}, logger)
const byName = new Map(definitions.map((definition) => [definition.name, definition]))

/**
 * Every `tool {action:"name"` reference in a piece of prose, as [tool, action] pairs.
 *
 * Only references to tools *this* plugin registers are returned: the prose deliberately points
 * at the sibling plugins too (`text_setup {action:"install"}` in dsh-ocr, `computer_click` in
 * dsh-computer-use), and those action names are not this plugin's to validate.
 */
function references(text) {
  return [...text.matchAll(/(?<![\w.])([a-z_]+) \{action:"([a-z_]+)"/g)]
    .filter((match) => lookupTool(match[1]) !== undefined)
    .map((match) => [match[1], match[2]])
}

/**
 * Every action named in a piece of prose for a tool this plugin registers.
 *
 * A reference qualified by a foreign tool name is skipped for the same reason `references`
 * filters: `text_setup {action:"install"}` names dsh-ocr's action, not ours.
 */
function namedActions(text) {
  return [...text.matchAll(/(?<![\w.])([a-z_]+)? ?\{action:"([a-z_]+)"/g)]
    .filter((match) => match[1] === undefined || lookupTool(match[1]) !== undefined)
    .map((match) => match[2])
}

/** Every action name that exists somewhere on the surface. */
const ALL_ACTIONS = new Set(
  Object.values(REGISTRY).flatMap((entry) => Object.keys(entry.actions)),
)

test('the registry and the registered surface describe the same thing', () => {
  assert.deepEqual(TOOL_NAMES, TOOL_ORDER)
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    TOOL_ORDER,
    'the registered order should be the order the guide presents',
  )

  for (const definition of definitions) {
    const entry = lookupTool(definition.name)
    assert.ok(entry, `${definition.name} must have a registry entry`)
    const declared = definition.parameters.properties.action.enum
    assert.deepEqual(
      Object.keys(entry.actions).sort(),
      [...declared].sort(),
      `${definition.name}: the registry and the schema must list the same actions`,
    )
  }

  for (const name of Object.keys(REGISTRY)) {
    assert.ok(byName.has(name), `${name} is documented but not registered`)
  }
})

test('no sentence is paid for twice inside one schema', () => {
  for (const definition of definitions) {
    const description = definition.description
    const actionDescription = definition.parameters.properties.action.description
    assert.ok(actionDescription.length > 0, `${definition.name} must explain its actions`)
    for (const line of actionDescription.split('\n')) {
      assert.ok(
        !description.includes(line),
        `${definition.name}: the action help is repeated word for word in the tool description`,
      )
    }
  }
})

test('every action is named in the text that describes the enum', () => {
  for (const definition of definitions) {
    const description = definition.parameters.properties.action.description
    for (const action of definition.parameters.properties.action.enum) {
      assert.ok(description.includes(action), `${definition.name}.${action} is in the enum but not explained`)
    }
  }
})

test('the resident surface stays inside its budget', () => {
  let bytes = 0
  for (const definition of definitions) {
    bytes += Buffer.byteLength(
      JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }),
      'utf8',
    )
    for (const line of definition.parameters.properties.action.description.split('\n')) {
      assert.ok(line.length <= 300, `${definition.name}: an action line of ${line.length} chars is too long to be resident`)
    }
  }
  // Measured on 2026-10-04: 48.6 KB across twelve tools and fifty-eight actions, with the
  // per-action detail moved into video_guide. The cap is deliberately close: adding resident
  // prose should be a decision, not a drift.
  assert.ok(bytes < 52_000, `the model-facing surface grew to ${bytes} bytes`)
  const guide = byName.get('video_guide')
  assert.ok(
    Buffer.byteLength(JSON.stringify(guide.parameters), 'utf8') < 3_200,
    'the guide itself must stay cheap, or the detail it carries is not on demand',
  )
})

test('video_guide answers for every tool and every action', async () => {
  const guide = byName.get('video_guide')
  const context = { cwd: process.cwd() }

  const overview = await guide.execute({ action: 'overview' }, context)
  for (const definition of definitions) {
    assert.ok(overview.text.includes(definition.name), `overview should cover ${definition.name}`)
    for (const action of definition.parameters.properties.action.enum) {
      assert.ok(overview.text.includes(action), `overview should list ${definition.name}.${action}`)
    }
  }

  for (const definition of definitions) {
    const entry = lookupTool(definition.name)
    const detail = await guide.execute({ action: 'tool', tool: definition.name }, context)
    assert.ok(detail.text.includes(entry.purpose), `${definition.name}: the tool page should lead with its purpose`)
    for (const action of definition.parameters.properties.action.enum) {
      assert.ok(detail.text.includes(action), `${definition.name}: the tool page should cover ${action}`)
      const entryForAction = lookupAction(definition.name, action)
      assert.ok(detail.text.includes(entryForAction.returns), `${definition.name}.${action}: the return shape belongs here`)

      const single = await guide.execute({ action: 'action', tool: definition.name, name: action }, context)
      assert.ok(single.text.includes(entryForAction.summary), `${definition.name}.${action}: the action page should lead with its summary`)
      for (const gotcha of entryForAction.gotchas) {
        assert.ok(single.text.includes(gotcha), `${definition.name}.${action}: every pitfall must be readable somewhere`)
      }
    }
  }
})

test('video_guide refuses unknown names with the legal ones', async () => {
  const guide = byName.get('video_guide')
  const context = { cwd: process.cwd() }
  await assert.rejects(() => guide.execute({ action: 'tool' }, context), /需要 "tool"/)
  await assert.rejects(() => guide.execute({ action: 'tool', tool: 'video_nope' }, context), /未知的工具/)
  await assert.rejects(() => guide.execute({ action: 'action', tool: 'video_render' }, context), /需要 "name"/)
  await assert.rejects(
    () => guide.execute({ action: 'action', tool: 'video_render', name: 'nope' }, context),
    /没有动作/,
  )
  await assert.rejects(() => guide.execute({ action: 'playbook', job: 'nope' }, context), /unknown job/)
})

test('the rules and the recipes only cite actions that exist', () => {
  const check = (text, where) => {
    for (const action of namedActions(text)) {
      assert.ok(ALL_ACTIONS.has(action), `${where} cites action "${action}", which does not exist`)
    }
    for (const [tool, action] of references(text)) {
      assert.ok(lookupAction(tool, action), `${where} cites ${tool}.${action}, which does not exist`)
    }
  }

  for (const [group, items] of Object.entries(GLOBAL_RULES)) {
    for (const item of items) check(item, `rule in ${group}`)
  }
  for (const [id, recipe] of Object.entries(PLAYBOOKS)) {
    assert.ok(recipe.steps.length >= 3, `${id} should describe a sequence, not a step`)
    assert.ok(recipe.pitfalls.length >= 1, `${id} should say what goes wrong`)
    for (const step of [...recipe.steps, ...recipe.pitfalls, recipe.when, recipe.goal]) {
      check(step, `playbook ${id}`)
    }
  }
})

test('every playbook is reachable from the guide and from the registry entry', async () => {
  const guide = byName.get('video_guide')
  const context = { cwd: process.cwd() }
  const list = await guide.execute({ action: 'playbook' }, context)
  for (const id of Object.keys(PLAYBOOKS)) {
    assert.ok(list.text.includes(id), `the recipe list should offer ${id}`)
    const one = await guide.execute({ action: 'playbook', job: id }, context)
    assert.ok(one.text.includes(PLAYBOOKS[id].title), `${id} should render its own title`)
  }
})
