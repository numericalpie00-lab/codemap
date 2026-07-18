# 🗺 CodeMap

A **live spatial map of your codebase** — so you stop getting lost in the linear scroll
of AI-assisted coding. The big picture is always on screen, and when your AI tool
(Claude Code, Cursor, anything) edits a file, the matching node **lights up** and lands
on a **"you are here"** timeline.

Built for the solo PM-engineer who vibe-codes and can't see the forest for the chat log.

## Run it

Zero dependencies. Just Node 20+.

```bash
node server.mjs /path/to/your/repo
# then open http://localhost:7100
```

Options: `--port 7100`. If you omit the repo path it uses the current directory.

Leave it open on a second monitor while you code. Edit a file → watch the node pulse.

## 🧠 语义分组（LLM semantic grouping）

By default files are grouped by **what they do** — intuitive Chinese business
domains like 用户认证 / 画布渲染 / 数据持久化 — not by which folder they live in.
An LLM reads each file's responsibility (top comment + exported symbols + path)
and clusters same-domain files into labelled bubbles. Perfect when the code is in
a language you don't read fluently: the *map* is in plain 中文.

Turn it on by pointing CodeMap at a model (pick one):

```bash
# 1) Anthropic — cheap & good (defaults to claude-haiku-4-5)
ANTHROPIC_API_KEY=sk-ant-... node server.mjs /path/to/repo

# 2) A local model (Ollama / LM Studio / vLLM — OpenAI-compatible)
LLM_BASE_URL=http://localhost:11434/v1 CODEMAP_MODEL=qwen2.5-coder node server.mjs /path/to/repo

# 3) OpenAI-compatible cloud
OPENAI_API_KEY=sk-... CODEMAP_MODEL=gpt-4o-mini node server.mjs /path/to/repo
```

Env vars: `ANTHROPIC_API_KEY`, `LLM_BASE_URL` (+ optional `OPENAI_API_KEY`),
`CODEMAP_MODEL` (override the model). **No key set → it just uses folder grouping**,
still fully usable.

How it behaves: the map renders instantly with folder grouping, then **upgrades in
place** to semantic domains a few seconds later (one batched call). Results cache to
`.codemap-cache.json`, keyed by each file's content digest — restarts are instant and
only changed files get re-classified.

## What it does today (v0)

- **Scans** the repo into a topology graph: files = nodes, `import`/`require` = edges,
  grouped into **domains** — by responsibility via an LLM (中文 business domains), or by
  folder as a fallback — and clustered into labelled bubbles on a force-directed map.
- **Watches** the filesystem. Any change updates the node's `lastChanged`, pulses it,
  and prepends it to the **session timeline** (right panel).
- **"You are here"** marks the most recently touched file.
- **Click** a node → its path, line count, and its dependencies (imports / imported-by),
  each clickable to hop around.
- **Search**, **domain filter** (click a legend row to hide/show), pan / zoom, drag to pin.

## How it's wired

```
server.mjs   Node http server, no deps.
             - scan()      walk repo → nodes + import edges
             - fs.watch    recursive watch → activity log + lastChanged
             - GET /api/state   the whole graph as JSON (frontend polls 1/s)
public/index.html   self-contained canvas app: force layout, live highlight,
                    timeline, detail popover.
```

The frontend polls `/api/state` every second, preserving node positions so the map
stays stable as files change.

## Extend it (the fun part)

✅ **LLM semantic grouping** — done (see 语义分组 above). `classifyDomains()` in
`server.mjs` reads file digests and names clusters by *responsibility* instead of by
directory. This is what turns a file graph into a *system* map.

Marked `// NEXT:` in `server.mjs`:

1. **Git-aware changes** — on change, run `git diff --stat` for real lines-added/removed,
   and let a node click show the actual diff.

Other natural next steps:
- **Session bridge**: tail the Claude Code transcript and link each map change back to the
  message/decision that caused it (turn the linear log into a spatial index).
- **C4 zoom levels**: system → container → component → file, collapsing domains into
  single super-nodes until you zoom in.
- **PM view**: a read-only layer with plain-language domain labels + status per area.

Tuned for JS/TS import graphs today; other languages still get the file/domain map
(edges are just sparser) — extend the import regex per language.
