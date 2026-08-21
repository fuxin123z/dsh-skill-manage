# dsh-skill-manage

[![npm version](https://img.shields.io/npm/v/dsh-skill-manage.svg)](https://www.npmjs.com/package/dsh-skill-manage)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent **procedural memory**: a `skill_manage` tool for authoring its own skills — create, patch, disable, delete — with layered delete guards. Built on `skill-filesystem`'s hot-reload watcher, so a skill created mid-session is usable in the same session, no restart.

Pair with [`dsh-auto-memory`](https://github.com/Aik358/dsh-auto-memory) for declarative memory: that one remembers *facts* (logs, notes, preferences), this one remembers *how to do things* (workflows, pitfalls, procedures).

## What it adds

**`skill_manage` tool** — actions: `create` / `patch` / `edit` / `delete` / `disable` / `enable` / `write_file` / `remove_file` / `list`

- **Two scopes** — `scope: 'user'` (default, `~/.dsh/skills`, all workspaces) or `scope: 'project'` (`<projectRoot>/.dsh/skills`, this workspace only). The project root is resolved exactly like the harness's own skill lookup: walk up from the session cwd to the nearest `.git`, falling back to the cwd itself. `list` shows both scopes in one table.
- **Disable/enable (reversible)** — toggles `disable-model-invocation` in SKILL.md frontmatter, the same key the harness's skill catalog filters on (`isModelInvocable`). Disabling hides a skill from the model's catalog without touching its content; enabling restores it. Prefer `disable` over `delete` for seasonal or off-context skills.
- **Trigger discipline** (English, static system-prompt section, cache-stable): create a skill when a complex task succeeded (5+ tool calls), errors were overcome, a user-corrected approach proved itself, or the user asks to remember a procedure; patch immediately when a skill hits uncovered pitfalls.
- **Delete guards**:
  - only skills carrying the `created_by: agent` frontmatter marker are deletable — marketplace/user skills are refused
  - `pinned: true` frontmatter blocks delete (patch/edit still allowed)
  - path confinement to the resolved skills root; symlinked skill directories refused
  - name-drift guard: patch/edit cannot silently rename a skill
- **Validation**: name regex + length, frontmatter requires `name` + `description`, description ≤1024 chars, SKILL.md ≤100k chars, supporting files ≤1 MiB, supporting paths confined to `references/ templates/ scripts/ assets/`
- **Atomic writes** (temp + rename) so the watcher never sees a half-written SKILL.md
- **CRLF-safe** frontmatter parsing

## Install

**Option A — via `dsh plugin`** (recommended; handles both steps below automatically):

```bash
dsh plugin --profile web add dsh-skill-manage
```

**Option B — manual npm install**, in your DSH profile dir (e.g. `~/.dsh/profiles/web`):

```bash
# 1. add the dependency
npm install dsh-skill-manage        # or: pnpm add dsh-skill-manage

# 2. register the bundle in package.json → dsh.profile.bundles:
#    "dsh": { "profile": { "bundles": [ ..., "dsh-skill-manage" ] } }

# 3. restart dsh web
```

The plugin needs no configuration. Log line `[dsh-skill-manage] ready` confirms it loaded.

**From source (local link)** — for development:

```bash
# in your DSH profile dir (e.g. ~/.dsh/profiles/web)
# 1. package.json dependencies:
#    "dsh-skill-manage": "link:/abs/path/to/dsh-skill-manage"
# 2. dsh.profile.bundles: append "dsh-skill-manage"
pnpm install
# 3. restart dsh web
```

## Develop & test

```bash
node test.mjs      # guard-level smoke tests (53 cases, sandboxed DSH_HOME)
node loadtest.mjs  # host-shape contract + real round-trip against ~/.dsh/skills
```

## v0 known limitations

- Flat layout only (`<root>/<name>/SKILL.md`); nested category dirs not listed
- No YAML multi-line block scalars (`description: |`) — keep values single-line
- Pin management is manual (edit frontmatter); no usage telemetry
- Project scope assumes one root per session (the session cwd's git root)

## License

MIT
