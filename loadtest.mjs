/**
 * Load test: simulates how the host would load this plugin —
 *   1. module imports cleanly (syntax + exports),
 *   2. apply(ctx) registers the tool + prompt section via the real service shapes,
 *   3. the registered tool executes end-to-end against the real ~/.dsh/skills,
 *      then cleans up.
 * Run: node loadtest.mjs
 */
import assert from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const mod = await import('./index.js')

// --- 1. exports ---
assert.strictEqual(mod.name, 'dsh-skill-manage', 'plugin name')
assert.deepStrictEqual(mod.inject, ['tools', 'systemPrompt'], 'inject services')
assert.strictEqual(typeof mod.apply, 'function', 'apply is a function')
console.log('✅ module exports: name / inject / apply')

// --- 2. mock ctx shaped like cordis services, call apply ---
const registered = { sections: [], tools: [], effects: [] }
const ctx = {
  systemPrompt: {
    section(def) {
      registered.sections.push(def)
      return () => {}
    },
  },
  tools: {
    register(tool) {
      registered.tools.push(tool)
      return () => {}
    },
  },
  effect(fn, label) { registered.effects.push(label); fn() },
}
mod.apply(ctx)

assert.strictEqual(registered.sections.length, 1, 'one prompt section registered')
const sec = registered.sections[0]
assert.strictEqual(sec.name, 'dsh-skill-manage:discipline')
assert.strictEqual(sec.order, 150)
assert.ok(sec.text.includes('procedural memory'), 'discipline text present')
assert.ok(sec.text.length < 1200, 'discipline stays lean')
assert.strictEqual(sec.text, sec.text.trim(), 'byte-stable static text (cache anchor)')

assert.strictEqual(registered.tools.length, 1, 'one tool registered')
const tool = registered.tools[0]
assert.strictEqual(tool.name, 'skill_manage')
assert.ok(tool.parameters.required.includes('action'))
assert.ok(tool.parameters.properties.action.enum.includes('create'))
// Host-load shape contract (learned 2026-08-21): the real host rejects a tool
// without `output: { schema, render }`, and the schema validator rejects
// `{ type: 'json' }` — only 'string' is accepted.
assert.ok(tool.output && tool.output.schema, 'tool.output.schema present (host rejects without it)')
assert.strictEqual(tool.output.schema.type, 'string', "output schema type must be 'string', not 'json'")
assert.strictEqual(typeof tool.output.render, 'function', 'tool.output.render is a function')
console.log('✅ apply(ctx): prompt section (order 150) + skill_manage tool registered (with output contract)')

// --- 3. execute the registered tool against the real skills root ---
const REAL_ROOT = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'skills')
const NAME = 'dsh-skill-manage-selftest'
const MD = `---
name: ${NAME}
description: Use when verifying the dsh-skill-manage plugin installation. Temporary self-test skill.
---

# Self-test

1. Created by the load test, hot-loaded by skill-filesystem watcher.
`

let r = JSON.parse(await tool.execute({ action: 'create', name: NAME, content: MD }))
assert.ok(r.success, 'create via registered tool: ' + JSON.stringify(r))
const onDisk = readFileSync(path.join(REAL_ROOT, NAME, 'SKILL.md'), 'utf8')
assert.ok(onDisk.includes('created_by: agent'), 'marker on disk')
console.log('✅ tool.execute(create) wrote to real skills root — watcher should hot-load it now')

r = JSON.parse(await tool.execute({ action: 'list' }))
const row = r.skills.find(s => s.name === NAME)
assert.ok(row && row.agent_created === true, 'list shows agent-created row')
console.log('✅ tool.execute(list) reflects the new skill')

r = JSON.parse(await tool.execute({ action: 'delete', name: NAME }))
assert.ok(r.success, 'delete: ' + JSON.stringify(r))
assert.ok(!existsSync(path.join(REAL_ROOT, NAME)), 'directory removed')
console.log('✅ tool.execute(delete) cleaned up')

console.log('\nAll load-test assertions passed.')
