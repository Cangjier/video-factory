#!/usr/bin/env node
/**
 * Report the model-facing cost of this plugin's tool surface.
 *
 * Every tool schema enters the model context on every turn, so the surface is a budget and
 * this is the meter: how many bytes each tool costs, how much of that is duplicated text, how
 * long the action lines are, and how much detail lives in the on-demand guide instead.
 *
 * The same numbers are asserted in `tests/surface.test.mjs`; this script is the human-readable
 * view of them, for comparing a change before and after.
 *
 * Usage: node src/bin/surface-report.mjs [--json]
 *
 * @module video-factory/bin/surface-report
 */
import { toolDefinitions, TOOL_NAMES } from '../tools/index.mjs'
import { PLAYBOOKS, GLOBAL_RULES } from '../tools/playbook.mjs'

const logger = { info() {}, warn() {}, error() {}, debug() {} }

/** Byte length of the part of a definition the model actually receives. */
function schemaBytes(definition) {
  return Buffer.byteLength(
    JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }),
    'utf8',
  )
}

const definitions = toolDefinitions({}, logger)
const rows = definitions.map((definition) => {
  const actionLine = definition.parameters.properties.action.description
  const lines = actionLine.split('\n')
  return {
    name: definition.name,
    actions: definition.parameters.properties.action.enum.length,
    arguments: Object.keys(definition.parameters.properties).length - 1,
    descriptionChars: definition.description.length,
    actionChars: actionLine.length,
    longestActionLine: Math.max(...lines.map((line) => line.length)),
    duplicatedChars: definition.description.includes(actionLine) ? actionLine.length : 0,
    bytes: schemaBytes(definition),
  }
})

const total = (key) => rows.reduce((sum, row) => sum + row[key], 0)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ tools: rows, totals: { bytes: total('bytes'), duplicatedChars: total('duplicatedChars') } }, null, 2))
} else {
  const pad = (value, width) => String(value).padStart(width)
  console.log('tool'.padEnd(22) + pad('act', 5) + pad('args', 6) + pad('desc', 7) + pad('action', 8) + pad('longest', 9) + pad('bytes', 8))
  for (const row of rows) {
    console.log(
      row.name.padEnd(22) +
        pad(row.actions, 5) +
        pad(row.arguments, 6) +
        pad(row.descriptionChars, 7) +
        pad(row.actionChars, 8) +
        pad(row.longestActionLine, 9) +
        pad(row.bytes, 8),
    )
  }
  console.log(
    '\n' +
      `tools ${TOOL_NAMES.length}, actions ${total('actions')}, ` +
      `resident ${total('bytes')} bytes, duplicated ${total('duplicatedChars')} chars`,
  )
  console.log(
    `guide content: ${Object.keys(PLAYBOOKS).length} playbooks, ` +
      `${Object.values(GLOBAL_RULES).reduce((sum, items) => sum + items.length, 0)} rules, ` +
      'rendered on demand and never resident',
  )
}
