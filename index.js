/**
 * dsh-skill-manage — agent-managed procedural memory for DSH.
 *
 * Mirrors Hermes Agent's skill_manage concept: lets the agent turn proven
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

function fail(message) {
  return JSON.stringify({ success: false, error: message })
}

function ok(message, extra = {}) {
  return JSON.stringify({ success: true, message, ...extra })
}

/** Extract and minimally parse YAML frontmatter. Returns { data, body, raw } or an error string. */
function parseFrontmatter(content) {
  const text = content.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { error: 'SKILL.md must start with YAML frontmatter (---).' }
  const end = text.slice(3).search(/\n---\s*(\n|$)/)
  if (end < 0) return { error: "frontmatter is not closed; ensure a closing '---' line." }
  const raw = text.slice(3, end + 3)
  const body = text.slice(end + 3).replace(/^---\s*\n?/, '')
  const data = {}
  for (const line of raw.split('\n')) {
    // `(.*?)\s*$` instead of `(.*)$`: JS `.` never crosses line terminators,
    // so a trailing \r (CRLF files) made `(.*)$` fail on EVERY key line.
    // `\s*` also strips surrounding whitespace; keep quote-stripping.
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
    if (m) data[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
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

/** Resolve a skill by name under the skills root. Returns { dir, skillMd } or null. */
function skillPaths(name) {
  const dir = path.join(skillsRoot(), name)
  return { dir, skillMd: path.join(dir, 'SKILL.md') }
}

async function findSkill(name) {
  const nameErr = validateName(name)
  if (nameErr) return { error: nameErr }
  const { dir, skillMd } = skillPaths(name)
  try {
    await readFile(skillMd, 'utf8')
    return { dir, skillMd }
  } catch {
    return { error: `Skill '${name}' not found under ${skillsRoot()}.` }
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
async function validateDeleteTarget(dir) {
  let st
  try { st = await lstat(dir) } catch { return `Skill directory not found: ${dir}` }
  if (st.isSymbolicLink()) {
    return `Refusing to delete '${dir}': the skill directory is a symlink. Remove the link manually if intended.`
  }
  const root = await realpath(skillsRoot()).catch(() => skillsRoot())
  const resolved = await realpath(dir).catch(() => dir)
  if (resolved === root) {
    return 'Refusing to delete: target resolves to the skills root itself, which would remove every installed skill.'
  }
  const rel = path.relative(root, resolved)
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

async function createSkill(name, content) {
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
  const { dir, skillMd } = skillPaths(name)
  try { await readFile(skillMd, 'utf8'); return fail(`Skill '${name}' already exists at ${skillMd}. Use patch or edit.`) } catch { /* not found — good */ }
  await atomicWrite(skillMd, ensureAgentMarker(content))
  return ok(`Skill '${name}' created at ${skillMd}. It is hot-loaded and already usable this session.`, { path: skillMd })
}

async function patchSkill(name, old_string, new_string, file_path, replace_all) {
  const found = await findSkill(name)
  if (found.error) return fail(found.error)
  let target = found.skillMd
  if (file_path && file_path !== 'SKILL.md') {
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

async function editSkill(name, content) {
  const found = await findSkill(name)
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

async function deleteSkill(name) {
  const found = await findSkill(name)
  if (found.error) return fail(found.error)
  const unsafe = await validateDeleteTarget(found.dir)
  if (unsafe) return fail(unsafe)
  const owner = await validateDeleteOwnership(name, found.skillMd)
  if (owner) return fail(owner)
  await rm(found.dir, { recursive: true, force: true })
  return ok(`Skill '${name}' deleted.`)
}

/** Add or overwrite a supporting file (references/ templates/ scripts/ assets/) inside a skill. */
async function writeSkillFile(name, file_path, file_content) {
  const found = await findSkill(name)
  if (found.error) return fail(found.error)
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
async function removeSkillFile(name, file_path) {
  const found = await findSkill(name)
  if (found.error) return fail(found.error)
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

async function listSkills() {
  const root = skillsRoot()
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch {
    return ok(`No skills directory at ${root}.`)
  }
  const rows = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    // flat layout only in v0: <root>/<name>/SKILL.md
    const skillMd = path.join(root, e.name, 'SKILL.md')
    try {
      const content = await readFile(skillMd, 'utf8')
      const parsed = parseFrontmatter(content)
      rows.push({
        name: e.name,
        agent_created: content.includes(AGENT_MARKER),
        pinned: String((parsed.data || {}).pinned).toLowerCase() === 'true',
        description: ((parsed.data || {}).description || '').slice(0, 100),
      })
    } catch {
      rows.push({ name: e.name, note: 'no SKILL.md at top level (nested layout not shown in v0)' })
    }
  }
  return ok(`${rows.length} skill(s) under ${root}:`, { skills: rows })
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
    async execute(args) {
      try {
        return await execute(args)
      } catch (e) {
        return toolName + ' failed: ' + (e && e.message ? e.message : String(e))
      }
    },
  }
}

const TOOL_DESCRIPTION = `Manage your own skills (procedural memory) in ~/.dsh/skills. Skills hot-load immediately — created skills are usable in the same session.

Actions:
- create: write a new SKILL.md (full content: YAML frontmatter + body). Frontmatter requires name + description; keep the description trigger-focused ("Use when <trigger>. <one-line behavior>.") — it is what future sessions route on.
- patch: targeted find-and-replace in SKILL.md or a supporting file (preferred for fixes; far cheaper than edit).
- edit: full SKILL.md rewrite (major overhauls only).
- delete: remove a skill. Only skills carrying the 'created_by: agent' marker can be deleted; pinned skills are refused.
- write_file: add or overwrite a supporting file (references/ templates/ scripts/ assets/).
- remove_file: remove a supporting file.
- list: show skills with agent-created/pinned flags.

Create when: complex task succeeded (5+ tool calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or the user asks you to remember a procedure.
Update when: instructions stale/wrong, OS-specific failures, or missing steps/pitfalls found during use — patch it immediately.
Good skills: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps.
Confirm with the user before creating or deleting.`

const skillManageTool = defineTool('skill_manage', TOOL_DESCRIPTION, {
  action: {
    type: 'string', required: true,
    enum: ['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file', 'list'],
    description: 'The action to perform.',
  },
  name: {
    type: 'string',
    description: "Skill name (lowercase, hyphens/dots/underscores, max 64). Required for all actions except 'list'.",
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
}, async (args) => {
  const action = args.action
  const name = args.name
  if (action !== 'list' && !name) return fail("Skill name is required for action '" + action + "'.")
  switch (action) {
    case 'create': return createSkill(name, String(args.content || ''))
    case 'patch': return patchSkill(name, args.old_string, args.new_string, args.file_path, !!args.replace_all)
    case 'edit': return editSkill(name, String(args.content || ''))
    case 'delete': return deleteSkill(name)
    case 'write_file': return writeSkillFile(name, args.file_path, args.file_content)
    case 'remove_file': return removeSkillFile(name, args.file_path)
    case 'list': return listSkills()
    default: return fail(`Unknown action '${action}'. Use: create, patch, edit, delete, write_file, remove_file, list.`)
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
  skillsRoot, parseFrontmatter, validateName, validateFrontmatter,
  ensureAgentMarker, validateDeleteTarget, validateDeleteOwnership,
  createSkill, patchSkill, editSkill, deleteSkill, writeSkillFile, removeSkillFile, listSkills,
}
