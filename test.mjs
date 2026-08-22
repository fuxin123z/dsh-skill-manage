/**
 * Smoke test for dsh-skill-manage: runs every action and every guard
 * against a sandboxed DSH_HOME, then cleans up.
 *
 *   node test.mjs
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
let r = parse(await I.createSkill('smoke-test-skill', SKILL_MD, SKILLS))
check('create succeeds', r.success, JSON.stringify(r))
check('file exists', existsSync(path.join(SKILLS, 'smoke-test-skill', 'SKILL.md')))
check('agent marker injected', readFileSync(path.join(SKILLS, 'smoke-test-skill', 'SKILL.md'), 'utf8').includes('created_by: agent'))

console.log('== 2. create: rejections ==')
r = parse(await I.createSkill('smoke-test-skill', SKILL_MD, SKILLS))
check('duplicate refused', !r.success)
r = parse(await I.createSkill('Bad_Name', SKILL_MD, SKILLS))
check('bad name refused', !r.success)
r = parse(await I.createSkill('no-fm-test', '# just markdown\nno frontmatter', SKILLS))
check('missing frontmatter refused', !r.success)
r = parse(await I.createSkill('fm-name-mismatch', SKILL_MD, SKILLS))
check('frontmatter/name mismatch refused', !r.success)

console.log('== 3. patch: happy path + supporting file ==')
r = parse(await I.patchSkill('smoke-test-skill', 'Step one.', 'Step one (verified).', undefined, false, SKILLS))
check('patch SKILL.md', r.success, JSON.stringify(r))
mkdirSync(path.join(SKILLS, 'smoke-test-skill', 'references'), { recursive: true })
const ref = path.join(SKILLS, 'smoke-test-skill', 'references', 'note.md')
await import('node:fs/promises').then(fs => fs.writeFile(ref, 'alpha beta\n', 'utf8'))
r = parse(await I.patchSkill('smoke-test-skill', 'alpha', 'gamma', 'references/note.md', false, SKILLS))
check('patch supporting file', r.success, JSON.stringify(r))
r = parse(await I.patchSkill('smoke-test-skill', 'nonexistent-string', 'x', undefined, false, SKILLS))
check('old_string miss refused', !r.success)

console.log('== 4. traversal + subdir guard ==')
r = parse(await I.patchSkill('smoke-test-skill', 'x', 'y', '../../escape.md', false, SKILLS))
check('path traversal refused', !r.success)
r = parse(await I.patchSkill('smoke-test-skill', 'x', 'y', 'docs/readme.md', false, SKILLS))
check('non-allowed subdir refused', !r.success)

console.log('== 5. edit: full rewrite ==')
const REWRITE = SKILL_MD.replace('Step one.', 'Step one. Step two. Step three.')
r = parse(await I.editSkill('smoke-test-skill', REWRITE, SKILLS))
check('edit succeeds', r.success, JSON.stringify(r))
r = parse(await I.editSkill('smoke-test-skill', 'no frontmatter', SKILLS))
check('edit with bad frontmatter refused', !r.success)

console.log('== 6. marketplace protection (no marker) ==')
mkdirSync(path.join(SKILLS, 'market-skill'), { recursive: true })
await import('node:fs/promises').then(fs => fs.writeFile(
  path.join(SKILLS, 'market-skill', 'SKILL.md'),
  '---\nname: market-skill\ndescription: installed from marketplace.\n---\nbody\n', 'utf8'))
r = parse(await I.deleteSkill('market-skill', SKILLS))
check('marketplace delete refused', !r.success && /not agent-created/.test(r.error), JSON.stringify(r))

console.log('== 7. pin guard ==')
const PINNED = REWRITE.replace('---\n', '---\npinned: true\n')
await I.editSkill('smoke-test-skill', PINNED, SKILLS)
r = parse(await I.deleteSkill('smoke-test-skill', SKILLS))
check('pinned delete refused', !r.success && /pinned/.test(r.error), JSON.stringify(r))
r = parse(await I.patchSkill('smoke-test-skill', 'Step three.', 'Step three (patched while pinned).', undefined, false, SKILLS))
check('pinned patch still allowed', r.success, JSON.stringify(r))

console.log('== 8. delete: happy path ==')
const UNPINNED = PINNED.replace('pinned: true\n', '')
await I.editSkill('smoke-test-skill', UNPINNED, SKILLS)
r = parse(await I.deleteSkill('smoke-test-skill', SKILLS))
check('agent skill deleted', r.success, JSON.stringify(r))
check('directory gone', !existsSync(path.join(SKILLS, 'smoke-test-skill')))

console.log('== 9. list (per-root rows) ==')
const rows = await I.listSkills(SKILLS, 'user')
check('list returns rows with flags', Array.isArray(rows) && rows.some(s => s.name === 'market-skill' && s.agent_created === false && s.disabled === false), JSON.stringify(rows))

console.log('== 9b. regression: fixes from 2026-08-21 review ==')
r = parse(await I.createSkill('smoke-test-skill', SKILL_MD, SKILLS))
check('re-create after earlier delete', r.success, JSON.stringify(r))

// (a) CRLF frontmatter must still get the agent marker (orphan bug).
const CRLF = '---\r\nname: smoke-crlf\r\ndescription: CRLF variant.\r\n---\r\n\r\nbody\r\n'
r = parse(await I.createSkill('smoke-crlf', CRLF, SKILLS))
check('CRLF create succeeds', r.success, JSON.stringify(r))
const crlfDisk = readFileSync(path.join(SKILLS, 'smoke-crlf', 'SKILL.md'), 'utf8')
check('CRLF create injects marker', crlfDisk.includes('created_by: agent'))
r = parse(await I.deleteSkill('smoke-crlf', SKILLS))
check('CRLF skill deletable (no orphan)', r.success, JSON.stringify(r))

// (b) edit must not drift the frontmatter name.
r = parse(await I.editSkill('smoke-test-skill', SKILL_MD.replace('name: smoke-test-skill', 'name: runaway-name'), SKILLS))
check('edit name drift refused', !r.success && /must match/.test(r.error), JSON.stringify(r))

// (c) patch must not drift the frontmatter name.
r = parse(await I.patchSkill('smoke-test-skill', 'name: smoke-test-skill', 'name: runaway-name', undefined, false, SKILLS))
check('patch name drift refused', !r.success && /must not change/.test(r.error), JSON.stringify(r))

// (d) patch with explicit file_path="SKILL.md" behaves like the default.
r = parse(await I.patchSkill('smoke-test-skill', 'Step one.', 'Step one (explicit path).', 'SKILL.md', false, SKILLS))
check('patch explicit SKILL.md path accepted', r.success, JSON.stringify(r))

// (e) write_file → patch it → remove_file round-trip.
r = parse(await I.writeSkillFile('smoke-test-skill', 'references/extra.md', 'draft line\n', SKILLS))
check('write_file creates supporting file', r.success, JSON.stringify(r))
r = parse(await I.patchSkill('smoke-test-skill', 'draft line', 'final line', 'references/extra.md', false, SKILLS))
check('patch written file', r.success, JSON.stringify(r))
r = parse(await I.writeSkillFile('smoke-test-skill', 'docs/escape.txt', 'x', SKILLS))
check('write_file non-allowed subdir refused', !r.success)
r = parse(await I.removeSkillFile('smoke-test-skill', 'references/extra.md', SKILLS))
check('remove_file deletes', r.success, JSON.stringify(r))
check('empty references dir pruned', !existsSync(path.join(SKILLS, 'smoke-test-skill', 'references')))
r = parse(await I.removeSkillFile('smoke-test-skill', 'references/extra.md', SKILLS))
check('remove_file missing file refused', !r.success)

// (f) literal replacement: `$` sequences in new_string must stay literal.
r = parse(await I.patchSkill('smoke-test-skill', 'Step one (explicit path).', 'regex: `(.*)$` and `$&` + `$1` stay literal.', undefined, false, SKILLS))
check('patch with $-sequences literal', r.success, JSON.stringify(r))
const dollarDisk = readFileSync(path.join(SKILLS, 'smoke-test-skill', 'SKILL.md'), 'utf8')
check('no splice on $ (single frontmatter)', dollarDisk.split('name: smoke-test-skill').length === 2, JSON.stringify(dollarDisk.slice(0, 200)))
check('$& literally present', dollarDisk.includes('`$&`'))

await I.deleteSkill('smoke-test-skill', SKILLS)

console.log('== 10. root delete refused (defense in depth) ==')
const guardErr = await I.validateDeleteTarget(SKILLS, SKILLS)
check('skills root refused', !!guardErr && /skills root/.test(guardErr), String(guardErr))

console.log('== 11. scope: project root resolution ==')
// Fake project: sandbox2/git-root with .git, nested cwd.
const PROJECT = path.join(process.cwd(), '.smoke-project')
const GIT_ROOT = path.join(PROJECT, 'repo')
const NESTED = path.join(GIT_ROOT, 'src', 'deep')
rmSync(PROJECT, { recursive: true, force: true })
mkdirSync(NESTED, { recursive: true })
mkdirSync(path.join(GIT_ROOT, '.git'), { recursive: true })
const resolved = await I.skillsRootFor('project', NESTED)
check('project root walks up to .git', resolved.root === path.join(GIT_ROOT, '.dsh', 'skills'), JSON.stringify(resolved))
r = parse(await I.createSkill('proj-only-skill', SKILL_MD.replace(/smoke-test-skill/g, 'proj-only-skill'), resolved.root))
check('create in project scope', r.success, JSON.stringify(r))
check('project skill file exists', existsSync(path.join(GIT_ROOT, '.dsh', 'skills', 'proj-only-skill', 'SKILL.md')))
// NOTE: must live OUTSIDE any git repo (the plugin's own .git sits above the
// sandbox — walk-up would legitimately find it, as the harness would too).
const noGitDir = path.join(homedir(), '.smoke-skill-manage-nogit')
mkdirSync(noGitDir, { recursive: true })
const noGitResolved = await I.skillsRootFor('project', noGitDir)
check('no .git anywhere → falls back to cwd as root (harness semantics)', !noGitResolved.error && noGitResolved.root === path.join(noGitDir, '.dsh', 'skills'), JSON.stringify(noGitResolved))
rmSync(noGitDir, { recursive: true, force: true })
rmSync(PROJECT, { recursive: true, force: true })

console.log('== 12. disable / enable ==')
r = parse(await I.createSkill('disable-me', SKILL_MD.replace(/smoke-test-skill/g, 'disable-me'), SKILLS))
check('create disable target', r.success, JSON.stringify(r))
r = parse(await I.setFrontmatterFlag('disable-me', 'disable-model-invocation', true, SKILLS))
check('disable writes flag', r.success, JSON.stringify(r))
const disDisk = readFileSync(path.join(SKILLS, 'disable-me', 'SKILL.md'), 'utf8')
check('frontmatter carries disable-model-invocation: true', /disable-model-invocation: true/.test(disDisk), disDisk.slice(0, 200))
check('agent marker survives disable', disDisk.includes('created_by: agent'))
r = parse(await I.setFrontmatterFlag('disable-me', 'disable-model-invocation', true, SKILLS))
check('double-disable is a no-op ok', r.success, JSON.stringify(r))
const rowsD = await I.listSkills(SKILLS, 'user')
check('list shows disabled flag', rowsD.some(s => s.name === 'disable-me' && s.disabled === true), JSON.stringify(rowsD))
r = parse(await I.setFrontmatterFlag('disable-me', 'disable-model-invocation', false, SKILLS))
check('enable removes flag', r.success, JSON.stringify(r))
const enDisk = readFileSync(path.join(SKILLS, 'disable-me', 'SKILL.md'), 'utf8')
check('flag removed on enable', !enDisk.includes('disable-model-invocation'), enDisk.slice(0, 200))
r = parse(await I.setFrontmatterFlag('disable-me', 'disable-model-invocation', false, SKILLS))
check('double-enable is a no-op ok', r.success, JSON.stringify(r))
// disable must also work on skills whose frontmatter already has other keys
r = parse(await I.setFrontmatterFlag('market-skill', 'disable-model-invocation', true, SKILLS))
check('disable non-agent skill allowed (no delete, just flag)', r.success, JSON.stringify(r))
r = parse(await I.setFrontmatterFlag('market-skill', 'disable-model-invocation', false, SKILLS))
check('re-enable non-agent skill', r.success, JSON.stringify(r))
// pinned skill can still be disabled
await I.editSkill('market-skill', '---\nname: market-skill\ndescription: installed from marketplace.\npinned: true\n---\nbody\n', SKILLS)
r = parse(await I.setFrontmatterFlag('market-skill', 'disable-model-invocation', true, SKILLS))
check('pinned skill disable allowed', r.success, JSON.stringify(r))
await I.setFrontmatterFlag('market-skill', 'disable-model-invocation', false, SKILLS)
await I.editSkill('market-skill', '---\nname: market-skill\ndescription: installed from marketplace.\n---\nbody\n', SKILLS)

console.log('== 13. pin / unpin ==')
r = parse(await I.setFrontmatterFlag('disable-me', 'pinned', true, SKILLS))
check('pin writes flag', r.success, JSON.stringify(r))
check('pinned flag on disk', /pinned: true/.test(readFileSync(path.join(SKILLS, 'disable-me', 'SKILL.md'), 'utf8')))
r = parse(await I.deleteSkill('disable-me', SKILLS))
check('pinned skill refuses delete', !r.success && /pinned/.test(r.error), JSON.stringify(r))
const rowsP = await I.listSkills(SKILLS, 'user')
check('list shows pinned flag', rowsP.some(s => s.name === 'disable-me' && s.pinned === true), JSON.stringify(rowsP))
r = parse(await I.patchSkill('disable-me', 'Step one.', 'patched step.', undefined, false, SKILLS))
check('pinned skill still patchable', r.success, JSON.stringify(r))
r = parse(await I.setFrontmatterFlag('disable-me', 'pinned', false, SKILLS))
check('unpin removes flag', r.success, JSON.stringify(r))
r = parse(await I.deleteSkill('disable-me', SKILLS))
check('delete works after unpin', r.success, JSON.stringify(r))
r = parse(await I.setFrontmatterFlag('market-skill', 'pinned', true, SKILLS))
check('pin non-agent skill allowed', r.success, JSON.stringify(r))
await I.setFrontmatterFlag('market-skill', 'pinned', false, SKILLS)

console.log('== 14. single-file skills (<root>/<name>.md) ==')
writeFileSync(path.join(SKILLS, 'flat-skill.md'), '---\nname: flat-skill\ndescription: single-file layout.\n---\nflat body\n')
const rowsF = await I.listSkills(SKILLS, 'user')
check('list shows single-file skill', rowsF.some(s => s.name === 'flat-skill' && s.layout === 'file'), JSON.stringify(rowsF))
r = parse(await I.setFrontmatterFlag('flat-skill', 'disable-model-invocation', true, SKILLS))
check('disable single-file skill', r.success, JSON.stringify(r))
r = parse(await I.deleteSkill('flat-skill', SKILLS))
check('single-file delete refused without marker', !r.success, JSON.stringify(r))
writeFileSync(path.join(SKILLS, 'flat-agent.md'), '---\nname: flat-agent\ndescription: single-file agent skill.\ncreated_by: agent\n---\nflat body\n')
r = parse(await I.deleteSkill('flat-agent', SKILLS))
check('single-file delete with marker', r.success, JSON.stringify(r))
check('single-file removed from disk', !existsSync(path.join(SKILLS, 'flat-agent.md')))
r = parse(await I.writeSkillFile('flat-skill', 'references/a.md', 'x', SKILLS))
check('write_file refused for single-file skill', !r.success && /single-file/.test(r.error), JSON.stringify(r))
rmSync(path.join(SKILLS, 'flat-skill.md'), { force: true })

console.log('== 15. frontmatter block scalars ==')
const blockMd = '---\nname: block-desc\ndescription: |\n  Use when testing multi-line descriptions.\n  Second line with: colon and --- hazards.\ncreated_by: agent\n---\nbody\n'
r = parse(await I.createSkill('block-desc', blockMd, SKILLS))
check('create with literal block scalar', r.success, JSON.stringify(r))
const blockParsed = I.parseFrontmatter(readFileSync(path.join(SKILLS, 'block-desc', 'SKILL.md'), 'utf8'))
check('literal block joined with newlines', blockParsed.data.description.includes('\n') && blockParsed.data.description.includes('Second line'), JSON.stringify(blockParsed.data))
const foldedMd = '---\nname: folded-desc\ndescription: >\n  folded first\n  folded second\n---\nbody\n'
r = parse(await I.createSkill('folded-desc', foldedMd, SKILLS))
check('create with folded block scalar', r.success, JSON.stringify(r))
const foldedParsed = I.parseFrontmatter(readFileSync(path.join(SKILLS, 'folded-desc', 'SKILL.md'), 'utf8'))
check('folded block joined with spaces', foldedParsed.data.description === 'folded first folded second', JSON.stringify(foldedParsed.data))
await I.deleteSkill('block-desc', SKILLS)
await I.deleteSkill('folded-desc', SKILLS)

console.log(`\n${passed} passed, ${failed} failed`)
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
