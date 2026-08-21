# dsh-skill-manage

DSH (DeepSeek Harness) plugin that gives the agent **procedural memory**: a Hermes-style `skill_manage` tool for creating, patching, and deleting skills in `~/.dsh/skills`, with an English trigger-discipline prompt section and layered delete guards. Built on top of `skill-filesystem`'s hot-reload watcher — created skills are usable in the same session, no restart.

Pair with [`dsh-auto-memory`](https://github.com/Aik358/dsh-auto-memory) for declarative memory: that one remembers *facts* (logs, notes, preferences), this one remembers *how to do things* (workflows, pitfalls, procedures).

## What it adds

- **`skill_manage` tool** with actions: `create` / `patch` / `edit` / `delete` / `write_file` / `remove_file` / `list`
- **Trigger discipline** (English, static system-prompt section, cache-stable): create a skill when a complex task succeeded (5+ tool calls), errors were overcome, a user-corrected approach proved itself, or the user asks to remember a procedure; patch immediately when a skill hits uncovered pitfalls
- **Delete guards**:
  - only skills carrying the `created_by: agent` frontmatter marker are deletable — marketplace/user skills are refused
  - `pinned: true` frontmatter blocks delete (patch/edit still allowed)
  - path confinement to the skills root; symlinked skill directories refused
  - name-drift guard: patch/edit cannot silently rename a skill
- **Validation**: name regex + length, frontmatter requires `name` + `description`, description ≤1024 chars, SKILL.md ≤100k chars, supporting files ≤1 MiB, supporting paths confined to `references/ templates/ scripts/ assets/`
- **Atomic writes** (temp + rename) so the watcher never sees a half-written SKILL.md
- **CRLF-safe** frontmatter parsing

## Install (local link)

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
node test.mjs      # guard-level smoke tests (34 cases, sandboxed DSH_HOME)
node loadtest.mjs  # host-shape contract + real round-trip against ~/.dsh/skills
```

## v0 known limitations

- Flat layout only (`<root>/<name>/SKILL.md`); nested category dirs not listed
- No YAML multi-line block scalars (`description: |`) — keep values single-line
- Pin management is manual (edit frontmatter); no usage telemetry

## License

MIT
