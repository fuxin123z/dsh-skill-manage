/**
 * Smoke test for dsh-skill-manage: runs every action and every guard
 * against a sandboxed DSH_HOME, then cleans up.
 *
 *   node test.mjs
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const SANDBOX = path.join(process.cwd(), '.smoke-sandbox')
const SKILLS = path.join(SANDBOX, 'skills')

// Sandbox before importing the plugin (skillsRoot reads DSH_HOME lazily per call,
// so this works — but set it first anyway for clarity).
process.env.DSH_HOME = SANDBOX
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SKILLS, { recursive: true })

const mod = await import('./index.js')
const I = mod._internals

let passed = 0, failed = 0
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label} ${detail}`) }
}
const parse = (s) => JSON.parse(s)

console.log('== 1. create: valid skill ==')
const SKILL_MD = `---
name: smoke-test-skill
description: Use when testing dsh-skill-manage. Verifies create/patch/delete round-trip.
---

# Smoke Test Skill

## When to Use
Testing.

## Procedure
1. Step one.
`
let r = parse(await I.createSkill('smoke-test-skill', SKILL_MD))
check('create succeeds', r.success, JSON.stringify(r))
check('file exists', existsSync(path.join(SKILLS, 'smoke-test-skill', 'SKILL.md')))
check('agent marker injected', readFileSync(path.join(SKILLS, 'smoke-test-skill', 'SKILL.md'), 'utf8').includes('created_by: agent'))

console.log('== 2. create: rejections ==')
r = parse(await I.createSkill('smoke-test-skill', SKILL_MD))
check('duplicate refused', !r.success)
r = parse(await I.createSkill('Bad_Name', SKILL_MD))
check('bad name refused', !r.success)
r = parse(await I.createSkill('no-fm-test', '# just markdown\nno frontmatter'))
check('missing frontmatter refused', !r.success)
r = parse(await I.createSkill('fm-name-mismatch', SKILL_MD))
check('frontmatter/name mismatch refused', !r.success)

console.log('== 3. patch: happy path + supporting file ==')
r = parse(await I.patchSkill('smoke-test-skill', 'Step one.', 'Step one (verified).'))
check('patch SKILL.md', r.success, JSON.stringify(r))
// write supporting file via patch-like path: use internals? patch only edits existing files.
// Create references/note.md through createSkill? No — emulate by writing via node, then patch it.
mkdirSync(path.join(SKILLS, 'smoke-test-skill', 'references'), { recursive: true })
const ref = path.join(SKILLS, 'smoke-test-skill', 'references', 'note.md')
await import('node:fs/promises').then(fs => fs.writeFile(ref, 'alpha beta\n', 'utf8'))
r = parse(await I.patchSkill('smoke-test-skill', 'alpha', 'gamma', 'references/note.md'))
check('patch supporting file', r.success, JSON.stringify(r))
r = parse(await I.patchSkill('smoke-test-skill', 'nonexistent-string', 'x'))
check('old_string miss refused', !r.success)

console.log('== 4. traversal + subdir guard ==')
r = parse(await I.patchSkill('smoke-test-skill', 'x', 'y', '../../escape.md'))
check('path traversal refused', !r.success)
r = parse(await I.patchSkill('smoke-test-skill', 'x', 'y', 'docs/readme.md'))
check('non-allowed subdir refused', !r.success)

console.log('== 5. edit: full rewrite ==')
const REWRITE = SKILL_MD.replace('Step one.', 'Step one. Step two. Step three.')
r = parse(await I.editSkill('smoke-test-skill', REWRITE))
check('edit succeeds', r.success, JSON.stringify(r))
r = parse(await I.editSkill('smoke-test-skill', 'no frontmatter'))
check('edit with bad frontmatter refused', !r.success)

console.log('== 6. marketplace protection (no marker) ==')
mkdirSync(path.join(SKILLS, 'market-skill'), { recursive: true })
await import('node:fs/promises').then(fs => fs.writeFile(
  path.join(SKILLS, 'market-skill', 'SKILL.md'),
  '---\nname: market-skill\ndescription: installed from marketplace.\n---\nbody\n', 'utf8'))
r = parse(await I.deleteSkill('market-skill'))
check('marketplace delete refused', !r.success && /not agent-created/.test(r.error), JSON.stringify(r))

console.log('== 7. pin guard ==')
const PINNED = REWRITE.replace('---\n', '---\npinned: true\n')
await I.editSkill('smoke-test-skill', PINNED)
r = parse(await I.deleteSkill('smoke-test-skill'))
check('pinned delete refused', !r.success && /pinned/.test(r.error), JSON.stringify(r))
r = parse(await I.patchSkill('smoke-test-skill', 'Step three.', 'Step three (patched while pinned).'))
check('pinned patch still allowed', r.success, JSON.stringify(r))

console.log('== 8. delete: happy path ==')
const UNPINNED = PINNED.replace('pinned: true\n', '')
await I.editSkill('smoke-test-skill', UNPINNED)
r = parse(await I.deleteSkill('smoke-test-skill'))
check('agent skill deleted', r.success, JSON.stringify(r))
check('directory gone', !existsSync(path.join(SKILLS, 'smoke-test-skill')))

console.log('== 9. list ==')
r = parse(await I.listSkills())
check('list works', r.success && Array.isArray(r.skills) && r.skills.some(s => s.name === 'market-skill' && s.agent_created === false), JSON.stringify(r))

console.log('== 9b. regression: fixes from 2026-08-21 review ==')
r = parse(await I.createSkill('smoke-test-skill', SKILL_MD))
check('re-create after earlier delete', r.success, JSON.stringify(r))

// (a) CRLF frontmatter must still get the agent marker (orphan bug).
const CRLF = '---\r\nname: smoke-crlf\r\ndescription: CRLF variant.\r\n---\r\n\r\nbody\r\n'
r = parse(await I.createSkill('smoke-crlf', CRLF))
check('CRLF create succeeds', r.success, JSON.stringify(r))
const crlfDisk = readFileSync(path.join(SKILLS, 'smoke-crlf', 'SKILL.md'), 'utf8')
check('CRLF create injects marker', crlfDisk.includes('created_by: agent'))
r = parse(await I.deleteSkill('smoke-crlf'))
check('CRLF skill deletable (no orphan)', r.success, JSON.stringify(r))

// (b) edit must not drift the frontmatter name.
r = parse(await I.editSkill('smoke-test-skill', SKILL_MD.replace('name: smoke-test-skill', 'name: runaway-name')))
check('edit name drift refused', !r.success && /must match/.test(r.error), JSON.stringify(r))

// (c) patch must not drift the frontmatter name.
r = parse(await I.patchSkill('smoke-test-skill', 'name: smoke-test-skill', 'name: runaway-name'))
check('patch name drift refused', !r.success && /must not change/.test(r.error), JSON.stringify(r))

// (d) patch with explicit file_path="SKILL.md" behaves like the default.
r = parse(await I.patchSkill('smoke-test-skill', 'Step one.', 'Step one (explicit path).', 'SKILL.md'))
check('patch explicit SKILL.md path accepted', r.success, JSON.stringify(r))

// (e) write_file → patch it → remove_file round-trip.
r = parse(await I.writeSkillFile('smoke-test-skill', 'references/extra.md', 'draft line\n'))
check('write_file creates supporting file', r.success, JSON.stringify(r))
r = parse(await I.patchSkill('smoke-test-skill', 'draft line', 'final line', 'references/extra.md'))
check('patch written file', r.success, JSON.stringify(r))
r = parse(await I.writeSkillFile('smoke-test-skill', 'docs/escape.txt', 'x'))
check('write_file non-allowed subdir refused', !r.success)
r = parse(await I.removeSkillFile('smoke-test-skill', 'references/extra.md'))
check('remove_file deletes', r.success, JSON.stringify(r))
check('empty references dir pruned', !existsSync(path.join(SKILLS, 'smoke-test-skill', 'references')))
r = parse(await I.removeSkillFile('smoke-test-skill', 'references/extra.md'))
check('remove_file missing file refused', !r.success)

await I.deleteSkill('smoke-test-skill')

console.log('== 10. root delete refused (defense in depth) ==')
// Cannot reach via public API (name regex blocks ""), so call the guard directly.
const guardErr = await I.validateDeleteTarget(SKILLS)
check('skills root refused', !!guardErr && /skills root/.test(guardErr), String(guardErr))

console.log(`\n${passed} passed, ${failed} failed`)
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
