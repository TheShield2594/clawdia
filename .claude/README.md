# `.claude/` — Claude Code project config

## Impeccable design skill (vendored)

`skills/impeccable/` and `agents/impeccable-*.md` are a vendored copy of
[impeccable](https://github.com/pbakaus/impeccable) (v4.3.1, Apache-2.0 — see
`skills/impeccable/LICENSE` and `NOTICE.md`). It gives Claude Code a
design-review skill: run `/impeccable <command> <target>` (e.g. `/impeccable
audit`, `/impeccable polish`, `/impeccable critique`), or use the standalone
detector directly with `npx impeccable detect <path-or-url>`.

`settings.json` wires the design detector into two hooks: a fast pass after every
`Edit`/`Write` on UI files, and a deeper pass on `Stop`. Both are guarded — they
no-op unless the launcher is present — so they never break a session. Remove the
`hooks` block if you don't want automatic scanning.

### First run

The launcher (`skills/impeccable/scripts/impeccable`) is a small shell script; on
first use it fetches a self-contained engine binary (no Node required). That
download needs open network access to the impeccable release host, so it happens
on a normal local machine, not inside a locked-down CI/egress sandbox.

To capture this repo's own design context for the skill, run once:

```
/impeccable init
```

which writes `PRODUCT.md` and `DESIGN.md` at the repo root.

### Updating

```
git clone --depth 1 https://github.com/pbakaus/impeccable /tmp/impeccable
rm -rf .claude/skills/impeccable .claude/agents/impeccable-*.md
cp -R /tmp/impeccable/.claude/skills/impeccable .claude/skills/impeccable
cp /tmp/impeccable/.claude/agents/impeccable-*.md .claude/agents/
cp /tmp/impeccable/LICENSE .claude/skills/impeccable/LICENSE
cp /tmp/impeccable/NOTICE.md .claude/skills/impeccable/NOTICE.md
```

Then re-check `settings.json` against the upstream `.claude/settings.json`.
