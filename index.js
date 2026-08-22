/**
 * dsh-skill-manage — agent-managed procedural memory for DSH.
 *
 * Gives the agent a skill_manage tool: lets the agent turn proven
 * workflows into reusable skills. The storage engine already exists — the
 * skill-filesystem watcher hot-loads anything written under ~/.dsh/skills —
 * so this plugin is only three things:
 *
 *   1. A validated `skill_manage` tool (create/patch/edit/delete/list).
 *   2. Delete guards: path confinement, agent-created marker, pin, symlink check.
 *   3. An English trigger-discipline section in the system prompt (cache-stable).
 *
 * Guard model (v0):
 *   - delete only touches skills whose SKILL.md frontmatter carries
 *     `created_by: agent`; marketplace/user skills are refused.
 *   - `pinned: true` in frontmatter blocks delete (patch/edit still allowed).
 *   - skill dir must resolve strictly inside ~/.dsh/skills and not be a symlink.
 *   - supporting files only under references/ templates/ scripts/ assets/.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-skill-manage'
export const inject = ['tools', 'systemPrompt']

export const usage = 'dsh-skill-manage'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_SKILL_CONTENT_CHARS = 100_000 // ~36k tokens
const MAX_SKILL_FILE_BYTES = 1_048_576 // 1 MiB per supporting file
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets'])
const AGENT_MARKER = 'created_by: agent'
const DISABLE_KEY = 'disable-model-invocation'
const PIN_KEY = 'pinned'
const SCOPES = ['user', 'project']

/** System prompt order: tool-guidance band is 100–199 (see dsh-system-prompt types). */
const SECTION_ORDER = 150

const TRIGGER_DISCIPLINE = `## Skill discipline (procedural memory)

skill_manage turns proven workflows into reusable skills. Skills live in ~/.dsh/skills and hot-load immediately — no restart.

Create a skill when: a complex task succeeded (5+ tool calls), you recovered from errors and found the working path, a user-corrected approach proved itself, or the user asks you to remember a procedure.
Patch a skill when: you used it and hit pitfalls, stale steps, or OS-specific failures it did not cover — fix it immediately, do not just work around it.
Skip one-off tasks. Offer to the user before creating or deleting; act directly on patches.

A good skill has: trigger conditions ("Use when …"), numbered steps with exact commands, a pitfalls section, and verification steps.`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skillsRoot() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'skills')
}

/**
 * Project root per harness skill-filesystem semantics: walk up from cwd
 * looking for `.git`; if none exists anywhere, the starting cwd IS the root
 * (the harness's findProjectRoot falls back to cwd the same way).
 */
async function projectRootFrom(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return null
  const start = path.resolve(cwd)
  let current = start
  while (true) {
    try { await lstat(path.join(current, '.git')); return current } catch { /* keep walking */ }
    const parent = path.dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/**
 * Resolve the skills root for a scope. 'user' → $DSH_HOME/skills (the
 * watcher's user-dsh root). 'project' → <projectRoot>/.dsh/skills where
 * projectRoot mirrors the harness's `.git`-walking findProjectRoot, seeded
 * from the session cwd when available.
 */
async function skillsRootFor(scope, sessionCwd) {
  if (scope === 'project') {
    const root = await projectRootFrom(sessionCwd)
    if (!root) {
      return { error: "scope 'project' requires an absolute session cwd (walk up from it to find the project root); none available." }
    }
    return { root: path.join(root, '.dsh', 'skills') }
  }
  return { root: skillsRoot() }
}


function validateScope(scope) {
  if (scope === undefined || scope === null || scope === '') return null
  if (!SCOPES.includes(scope)) {
    return `Invalid scope '${scope}'. Use 'user' (default, $DSH_HOME/skills) or 'project' (<projectRoot>/.dsh/skills).`
  }
  return null
}

function fail(message) {
  return JSON.stringify({ success: false, error: message })
}

function ok(message, extra = {}) {
  return JSON.stringify({ success: true, message, ...extra })
}

/**
 * Extract and minimally parse YAML frontmatter. Returns { data, body, raw }
 * or an error string. Supports plain `key: value` lines plus literal (`|`)
 * and folded (`>`) block scalars — the two forms that appear in real-world
 * SKILL.md descriptions. Flow sequences/mappings are left unparsed (kept as
 * raw strings), matching how the harness's own lenient reader treats them.
 */
function parseFrontmatter(content) {
  const text = content.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { error: 'SKILL.md must start with YAML frontmatter (---).' }
  const end = text.slice(3).search(/\n---\s*(\n|$)/)
  if (end < 0) return { error: "frontmatter is not closed; ensure a closing '---' line." }
  const raw = text.slice(3, end + 3)
  const body = text.slice(end + 3).replace(/^---\s*\n?/, '')
  const data = {}
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // `(.*?)\s*$` instead of `(.*)$`: JS `.` never crosses line terminators,
    // so a trailing \r (CRLF files) made `(.*)$` fail on EVERY key line.
    // `\s*` also strips surrounding whitespace; keep quote-stripping.
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
    if (!m) continue
    const [, key, value] = m
    if (value === '|' || value === '|-' || value === '|+' || value === '>' || value === '>-' || value === '>+') {
      // Block scalar: consume following lines that are more indented (or blank).
      const block = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const next = lines[j]
        if (next.trim() === '') { block.push(''); continue }
        if (/^[ \t]/.test(next)) { block.push(next.replace(/\r$/, '')); continue }
        break
      }
      i = j - 1
      const stripped = block.map((l) => l.replace(/^[ \t]{1,8}/, ''))
      let joined
      if (value.startsWith('|')) joined = stripped.join('\n')
      else joined = stripped.join(' ') // folded: newlines → spaces
      joined = joined.replace(/\n{3,}/g, '\n\n') // clip: collapse trailing blank runs
      if (!value.endsWith('-')) {
        // chomping keep/clip both terminate with exactly one newline
        joined = joined.replace(/\s+$/, '\n')
      } else {
        joined = joined.replace(/\s+$/, '')
      }
      data[key] = joined.trim() === '' ? '' : joined
      continue
    }
    data[key] = value.replace(/^['"]|['"]$/g, '')
  }
  return { data, body, raw }
}

function validateName(name) {
  if (!name) return 'Skill name is required.'
  if (name.length > MAX_NAME_LENGTH) return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name '${name}'. Use lowercase letters, numbers, hyphens, dots, underscores; must start with a letter or digit.`
  }
  return null
}

function validateFrontmatter(content) {
  if (!content.trim()) return 'Content cannot be empty.'
  const parsed = parseFrontmatter(content)
  if (parsed.error) return parsed.error
  const { data } = parsed
  if (!data.name) return "frontmatter must include a 'name' field."
  if (!data.description) return "frontmatter must include a 'description' field."
  if (data.description.length > MAX_DESCRIPTION_LENGTH) {
    return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`
  }
  return null
}

/** Inject the agent marker into frontmatter if absent (create path only). CRLF-safe. */
function ensureAgentMarker(content) {
  if (content.includes(AGENT_MARKER)) return content
  return content.replace(/^---\r?\n/, (m) => m + AGENT_MARKER + (m.endsWith('\r\n') ? '\r\n' : '\n'))
}

/** Resolve a skill by name under a skills root. Returns { dir, skillMd } or null. */
function skillPaths(name, root) {
  const dir = path.join(root, name)
  return { dir, skillMd: path.join(dir, 'SKILL.md') }
}

/**
 * Resolve a skill by name under a skills root, in the two layouts the
 * skill-filesystem watcher actually loads: <root>/<name>/SKILL.md (directory
 * skill) and <root>/<name>.md (single-file skill). Returns
 * { dir, skillMd, layout } or an error string.
 */
async function findSkill(name, root) {
  const nameErr = validateName(name)
  if (nameErr) return { error: nameErr }
  const { dir, skillMd } = skillPaths(name, root)
  try {
    await readFile(skillMd, 'utf8')
    return { dir, skillMd, root, layout: 'dir' }
  } catch { /* fall through to the single-file layout */ }
  const fileMd = path.join(root, name + '.md')
  try {
    await readFile(fileMd, 'utf8')
    return { dir: null, skillMd: fileMd, root, layout: 'file' }
  } catch {
    return { error: `Skill '${name}' not found under ${root} (looked for ${name}/SKILL.md and ${name}.md).` }
  }
}

/** Validate a supporting-file path: single allowed subdir, no traversal, no symlink components. */
async function resolveSupportingFile(dir, file_path) {
  if (!file_path) return { error: 'file_path is required for this action.' }
  const rel = path.normalize(file_path)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: `file_path must stay inside the skill directory.` }
  const top = rel.split(path.sep)[0]
  if (!ALLOWED_SUBDIRS.has(top)) {
    return { error: `file_path must be under one of: ${[...ALLOWED_SUBDIRS].join('/, ')}/ (got '${top}').` }
  }
  return { target: path.join(dir, rel) }
}

/** Atomic write: temp file + rename, so the watcher never sees a half-written SKILL.md. */
async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now()
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, target)
}

// ---------------------------------------------------------------------------
// Delete guards
// ---------------------------------------------------------------------------

/**
 * Last-line defense before recursive delete. Refuses:
 *   1. paths not strictly inside the skills root,
 *   2. the skills root itself,
 *   3. skill directories reached via symlink (rmtree redirect).
 */
async function validateDeleteTarget(dir, root) {
  let st
  try { st = await lstat(dir) } catch { return `Skill directory not found: ${dir}` }
  if (st.isSymbolicLink()) {
    return `Refusing to delete '${dir}': the skill directory is a symlink. Remove the link manually if intended.`
  }
  const resolvedRoot = await realpath(root).catch(() => root)
  const resolved = await realpath(dir).catch(() => dir)
  if (resolved === resolvedRoot) {
    return 'Refusing to delete: target resolves to the skills root itself, which would remove every installed skill.'
  }
  const rel = path.relative(resolvedRoot, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return `Refusing to delete '${dir}': path does not resolve inside the skills root.`
  }
  return null
}

/** Agent-created + pin guards: refuse delete for marketplace/user skills and pinned skills. */
async function validateDeleteOwnership(name, skillMd) {
  let content
  try { content = await readFile(skillMd, 'utf8') } catch { return null /* findSkill already verified it exists */ }
  const parsed = parseFrontmatter(content)
  const data = parsed.data || {}
  if (String(data.pinned).toLowerCase() === 'true') {
    return `Skill '${name}' is pinned (frontmatter \`pinned: true\`) and cannot be deleted. Remove the pin flag first; patches and edits remain allowed.`
  }
  if (!content.includes(AGENT_MARKER)) {
    return `Refusing to delete '${name}': not agent-created (no \`${AGENT_MARKER}\` marker in frontmatter). Marketplace and user-authored skills are off-limits to skill_manage delete.`
  }
  return null
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function createSkill(name, content, root) {
  const nameErr = validateName(name)
  if (nameErr) return fail(nameErr)
  const fmErr = validateFrontmatter(content)
  if (fmErr) return fail(fmErr)
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return fail(`Content is ${content.length} chars (limit ${MAX_SKILL_CONTENT_CHARS}). Split into supporting files.`)
  }
  const parsed = parseFrontmatter(content)
  if (parsed.data.name !== name) {
    return fail(`frontmatter name '${parsed.data.name}' must match the requested skill name '${name}'.`)
  }
  const { dir, skillMd } = skillPaths(name, root)
  try { await readFile(skillMd, 'utf8'); return fail(`Skill '${name}' already exists at ${skillMd}. Use patch or edit.`) } catch { /* not found — good */ }
  await atomicWrite(skillMd, ensureAgentMarker(content))
  return ok(`Skill '${name}' created at ${skillMd}. It is hot-loaded and already usable this session.`, { path: skillMd })
}

async function patchSkill(name, old_string, new_string, file_path, replace_all, root) {
  const found = await findSkill(name, root)
  if (found.error) return fail(found.error)
  let target = found.skillMd
  if (file_path && file_path !== 'SKILL.md') {
    if (found.layout === 'file') return fail(`Skill '${name}' is a single-file skill (${name}.md) with no supporting files.`)
    const r = await resolveSupportingFile(found.dir, file_path)
    if (r.error) return fail(r.error)
    target = r.target
  }
  let content
  try { content = await readFile(target, 'utf8') } catch {
    return fail(`File '${file_path || 'SKILL.md'}' not found in skill '${name}'.`)
  }
  if (!old_string) return fail('old_string is required for patch.')
  if (new_string === undefined || new_string === null) return fail('new_string is required for patch (use empty string to delete).')
  const count = content.split(old_string).length - 1
  if (count === 0) return fail('old_string not found in target file.')
  if (count > 1 && !replace_all) {
    return fail(`old_string appears ${count} times; pass replace_all=true or add surrounding context to make it unique.`)
  }
  // split/join for BOTH branches: String.replace treats `$` sequences in the
  // replacement as special patterns (`$&`, `$'`, `$`` insert match/prefix/suffix
  // text) — a new_string containing regex like `(.*)$` corrupted SKILL.md by
  // splicing whole-file copies into the output. split/join is literal.
  const updated = content.split(old_string).join(new_string)
  if (target === found.skillMd) {
    const fmErr = validateFrontmatter(updated)
    if (fmErr) return fail(`patch broke the SKILL.md: ${fmErr}`)
    // Name drift guard: a patch may not rename the skill — directory name and
    // frontmatter name must stay in lockstep or list/watcher views diverge.
    const patchedName = parseFrontmatter(updated).data.name
    if (patchedName !== name) {
      return fail(`patch must not change the frontmatter name ('${patchedName}' != '${name}'). Delete and recreate under the new name instead.`)
    }
  }
  await atomicWrite(target, updated)
  return ok(`Patched ${file_path || 'SKILL.md'} in skill '${name}' (${replace_all ? count + ' occurrences' : '1 occurrence'}).`)
}

async function editSkill(name, content, root) {
  const found = await findSkill(name, root)
  if (found.error) return fail(found.error)
  const fmErr = validateFrontmatter(content)
  if (fmErr) return fail(fmErr)
  // Name drift guard: a rewrite must keep the frontmatter name aligned with
  // the directory name (same invariant create enforces).
  const editedName = parseFrontmatter(content).data.name
  if (editedName !== name) {
    return fail(`frontmatter name '${editedName}' must match the existing skill name '${name}'. Delete and recreate under the new name instead.`)
  }
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return fail(`Content is ${content.length} chars (limit ${MAX_SKILL_CONTENT_CHARS}).`)
  }
  // A full rewrite must not silently strip the agent marker — doing so would
  // orphan the skill (delete guard would then refuse it forever).
  let existing = ''
  try { existing = await readFile(found.skillMd, 'utf8') } catch { /* new file */ }
  const next = existing.includes(AGENT_MARKER) ? ensureAgentMarker(content) : content
  await atomicWrite(found.skillMd, next)
  return ok(`Skill '${name}' SKILL.md fully rewritten.`)
}

async function deleteSkill(name, root) {
  const found = await findSkill(name, root)
  if (found.error) return fail(found.error)
  if (found.layout === 'file') {
    // Single-file skill: the guards below check directory containment, which
    // does not apply — apply the ownership guards to the .md file itself.
    const owner = await validateDeleteOwnership(name, found.skillMd)
    if (owner) return fail(owner)
    await rm(found.skillMd, { force: true })
    return ok(`Skill '${name}' deleted (${name}.md).`)
  }
  const unsafe = await validateDeleteTarget(found.dir, root)
  if (unsafe) return fail(unsafe)
  const owner = await validateDeleteOwnership(name, found.skillMd)
  if (owner) return fail(owner)
  await rm(found.dir, { recursive: true, force: true })
  return ok(`Skill '${name}' deleted.`)
}

/** Add or overwrite a supporting file (references/ templates/ scripts/ assets/) inside a skill. */
async function writeSkillFile(name, file_path, file_content, root) {
  const found = await findSkill(name, root)
  if (found.error) return fail(found.error)
  if (found.layout === 'file') return fail(`Skill '${name}' is a single-file skill (${name}.md) with no supporting files.`)
  const r = await resolveSupportingFile(found.dir, file_path)
  if (r.error) return fail(r.error)
  if (file_content === undefined || file_content === null) return fail('file_content is required for write_file.')
  const bytes = Buffer.byteLength(String(file_content), 'utf8')
  if (bytes > MAX_SKILL_FILE_BYTES) {
    return fail(`File content is ${bytes} bytes (limit ${MAX_SKILL_FILE_BYTES} / 1 MiB). Split into smaller files.`)
  }
  await atomicWrite(r.target, String(file_content))
  return ok(`File '${file_path}' written to skill '${name}'.`, { path: r.target })
}

/** Remove a supporting file from a skill; prunes the empty parent subdir. */
async function removeSkillFile(name, file_path, root) {
  const found = await findSkill(name, root)
  if (found.error) return fail(found.error)
  if (found.layout === 'file') return fail(`Skill '${name}' is a single-file skill (${name}.md) with no supporting files.`)
  const r = await resolveSupportingFile(found.dir, file_path)
  if (r.error) return fail(r.error)
  try { await readFile(r.target, 'utf8') } catch {
    return fail(`File '${file_path}' not found in skill '${name}'.`)
  }
  await rm(r.target, { force: true })
  const parent = path.dirname(r.target)
  if (parent !== found.dir) {
    let entries = []
    try { entries = await readdir(parent) } catch { /* gone */ }
    if (!entries.length) await rm(parent, { recursive: true, force: true }).catch(() => {})
  }
  return ok(`File '${file_path}' removed from skill '${name}'.`)
}

async function listSkills(root, scopeLabel) {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch {
    return [] // missing root = no skills there (project roots often absent)
  }
  const rows = []
  const seen = new Set()
  const pushRow = (name, content, layout) => {
    if (seen.has(name)) return
    seen.add(name)
    const parsed = parseFrontmatter(content)
    const data = parsed.data || {}
    rows.push({
      name,
      scope: scopeLabel,
      layout,
      agent_created: content.includes(AGENT_MARKER),
      pinned: String(data.pinned).toLowerCase() === 'true',
      disabled: String(data[DISABLE_KEY]).toLowerCase() === 'true',
      description: (data.description || '').slice(0, 100),
    })
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      // directory skill: <root>/<name>/SKILL.md (the layout skill_manage creates)
      const skillMd = path.join(root, e.name, 'SKILL.md')
      try {
        pushRow(e.name, await readFile(skillMd, 'utf8'), 'dir')
      } catch {
        rows.push({ name: e.name, scope: scopeLabel, note: 'no SKILL.md inside (not loaded by the watcher either)' })
      }
    } else if (e.isFile() && e.name.endsWith('.md')) {
      // single-file skill: <root>/<name>.md (also loaded by the watcher)
      try {
        pushRow(e.name.slice(0, -3), await readFile(path.join(root, e.name), 'utf8'), 'file')
      } catch { /* unreadable — skip */ }
    }
  }
  return rows
}

/**
 * Set or clear a boolean frontmatter flag (disable-model-invocation, pinned)
 * on a SKILL.md, preserving everything else. The official harness reader
 * (frontmatterBoolean) accepts true/yes/on — we write plain `true`/absent.
 */
async function setFrontmatterFlag(name, key, set, root) {
  const found = await findSkill(name, root)
  if (found.error) return fail(found.error)
  let content
  try { content = await readFile(found.skillMd, 'utf8') } catch { return fail(`Cannot read ${found.skillMd}.`) }
  const parsed = parseFrontmatter(content)
  if (parsed.error) return fail(`Refusing to touch '${name}': ${parsed.error}`)
  const lines = content.split('\n')
  const fmEnd = lines.indexOf('---', 1)
  if (fmEnd < 0) return fail(`Refusing to touch '${name}': cannot locate end of frontmatter.`)
  let keyLine = -1
  for (let i = 1; i < fmEnd; i++) {
    if (/^([A-Za-z0-9_-]+):\s/.test(lines[i]) && lines[i].startsWith(key + ':')) { keyLine = i; break }
  }
  const currentlySet = String((parsed.data || {})[key]).toLowerCase() === 'true'
  if (set) {
    if (currentlySet) return ok(`Skill '${name}' already has ${key}: true.`)
    const line = `${key}: true`
    if (keyLine >= 0) lines[keyLine] = line
    else lines.splice(fmEnd, 0, line)
  } else {
    if (!currentlySet) return ok(`Skill '${name}' does not have ${key} set.`)
    if (keyLine < 0) return fail(`Skill '${name}' has ${key} set via an unexpected form; edit manually.`)
    lines.splice(keyLine, 1)
  }
  const updated = lines.join('\n')
  const fmErr = validateFrontmatter(updated)
  if (fmErr) return fail(`Refusing to write broken SKILL.md: ${fmErr}`)
  await atomicWrite(found.skillMd, updated)
  return ok(`Skill '${name}': ${key} ${set ? 'set' : 'removed'}.`)
}

// ---------------------------------------------------------------------------
// Tool definition + plugin apply
// ---------------------------------------------------------------------------

function defineTool(toolName, description, parameters, execute) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters || {})) {
    const prop = { type: spec.type || 'string', description: spec.description || '' }
    if (spec.enum) prop.enum = spec.enum
    properties[key] = prop
    if (spec.required) required.push(key)
  }
  return {
    name: toolName,
    description,
    parameters: { type: 'object', properties, required },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    async execute(args, exec) {
      try {
        return await execute(args, exec)
      } catch (e) {
        return toolName + ' failed: ' + (e && e.message ? e.message : String(e))
      }
    },
  }
}

const TOOL_DESCRIPTION = `Manage your own skills (procedural memory) in $DSH_HOME/skills (scope 'user') or <projectRoot>/.dsh/skills (scope 'project', the git root of the current session). Skills hot-load immediately — created skills are usable in the same session.

Actions:
- create: write a new SKILL.md (full content: YAML frontmatter + body). Frontmatter requires name + description; keep the description trigger-focused ("Use when <trigger>. <one-line behavior>.") — it is what future sessions route on.
- patch: targeted find-and-replace in SKILL.md or a supporting file (preferred for fixes; far cheaper than edit).
- edit: full SKILL.md rewrite (major overhauls only).
- delete: remove a skill. Only skills carrying the 'created_by: agent' marker can be deleted; pinned skills are refused.
- disable / enable: toggle 'disable-model-invocation' in frontmatter — hides the skill from the model catalog without deleting (reversible). Prefer disable over delete for seasonal/off-context skills.
- pin / unpin: toggle the 'pinned' frontmatter flag — a pinned skill cannot be deleted by skill_manage (patches still allowed). Pin skills that must survive cleanups.
- write_file: add or overwrite a supporting file (references/ templates/ scripts/ assets/).
- remove_file: remove a supporting file.
- list: show skills in both scopes with agent-created/pinned/disabled flags.

Create when: complex task succeeded (5+ tool calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or the user asks you to remember a procedure.
Update when: instructions stale/wrong, OS-specific failures, or missing steps/pitfalls found during use — patch it immediately.
Good skills: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps.
Confirm with the user before creating or deleting.`

const skillManageTool = defineTool('skill_manage', TOOL_DESCRIPTION, {
  action: {
    type: 'string', required: true,
    enum: ['create', 'patch', 'edit', 'delete', 'disable', 'enable', 'pin', 'unpin', 'write_file', 'remove_file', 'list'],
    description: 'The action to perform.',
  },
  name: {
    type: 'string',
    description: "Skill name (lowercase, hyphens/dots/underscores, max 64). Required for all actions except 'list'.",
  },
  scope: {
    type: 'string',
    enum: SCOPES,
    description: "Where the skill lives: 'user' (default, $DSH_HOME/skills, all workspaces) or 'project' (<git-root>/.dsh/skills, this workspace only).",
  },
  content: {
    type: 'string',
    description: "Full SKILL.md text (frontmatter + body). Required for 'create' and 'edit'.",
  },
  old_string: { type: 'string', description: "Text to find (required for 'patch'). Unique unless replace_all=true." },
  new_string: { type: 'string', description: "Replacement text (required for 'patch'); empty string deletes the match." },
  replace_all: { type: 'boolean', description: "For 'patch': replace every occurrence (default false)." },
  file_path: {
    type: 'string',
    description: "Supporting file inside the skill (references/ templates/ scripts/ assets/). For 'patch': optional, 'SKILL.md' or omitted targets the main file.",
  },
  file_content: {
    type: 'string',
    description: "Content for the file. Required for 'write_file' (max 1 MiB).",
  },
}, async (args, exec) => {
  const action = args.action
  const name = args.name
  if (action !== 'list' && !name) return fail("Skill name is required for action '" + action + "'.")
  const scopeErr = validateScope(args.scope)
  if (scopeErr) return fail(scopeErr)
  const scope = args.scope || 'user'
  // Session cwd drives the project root exactly like the harness's own
  // skill lookups (exec.agent.session.header.cwd).
  const sessionCwd = exec?.agent?.session?.header?.cwd
  if (action === 'list') {
    const roots = []
    const userRoot = skillsRoot()
    roots.push({ root: userRoot, label: 'user' })
    const proj = await skillsRootFor('project', sessionCwd)
    if (proj.root && proj.root !== userRoot) roots.push({ root: proj.root, label: 'project' })
    const rows = []
    for (const r of roots) rows.push(...await listSkills(r.root, r.label))
    if (!rows.length) return ok('No skills found in either scope.')
    return ok(`${rows.length} skill(s):`, { skills: rows })
  }
  const resolved = await skillsRootFor(scope, sessionCwd)
  if (resolved.error) return fail(resolved.error)
  const root = resolved.root
  switch (action) {
    case 'create': return createSkill(name, String(args.content || ''), root)
    case 'patch': return patchSkill(name, args.old_string, args.new_string, args.file_path, !!args.replace_all, root)
    case 'edit': return editSkill(name, String(args.content || ''), root)
    case 'delete': return deleteSkill(name, root)
    case 'disable': return setFrontmatterFlag(name, DISABLE_KEY, true, root)
    case 'enable': return setFrontmatterFlag(name, DISABLE_KEY, false, root)
    case 'pin': return setFrontmatterFlag(name, PIN_KEY, true, root)
    case 'unpin': return setFrontmatterFlag(name, PIN_KEY, false, root)
    case 'write_file': return writeSkillFile(name, args.file_path, args.file_content, root)
    case 'remove_file': return removeSkillFile(name, args.file_path, root)
    default: return fail(`Unknown action '${action}'. Use: create, patch, edit, delete, disable, enable, pin, unpin, write_file, remove_file, list.`)
  }
})

export function apply(ctx) {
  // English trigger discipline: static text keeps the system prompt
  // byte-stable, preserving the DeepSeek prefix cache (same idiom as
  // dsh-auto-memory's section anchoring).
  const disposeSection = ctx.systemPrompt.section({
    name: 'dsh-skill-manage:discipline',
    order: SECTION_ORDER,
    text: TRIGGER_DISCIPLINE,
  })

  const disposeTool = ctx.tools.register(skillManageTool)

  ctx.effect(() => () => {
    try { disposeSection() } catch { /* noop */ }
    try { disposeTool() } catch { /* noop */ }
  }, 'dsh-skill-manage: surfaces')

  console.log('[dsh-skill-manage] ready: skill_manage tool + trigger-discipline section')
}

// Exported for smoke tests without a running host.
export const _internals = {
  skillsRoot, skillsRootFor, projectRootFrom, parseFrontmatter, validateName,
  validateFrontmatter, ensureAgentMarker, validateDeleteTarget, validateDeleteOwnership,
  createSkill, patchSkill, editSkill, deleteSkill, setFrontmatterFlag,
  writeSkillFile, removeSkillFile, listSkills,
}
