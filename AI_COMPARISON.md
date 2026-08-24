# Choosing an AI Provider

Clawdia ships five AI providers. Each is a module in
[`src/services/ai/providers/`](src/services/ai/providers/) implementing one
interface and registered in `providers/index.js` — that registry is the source
of truth for everything in the table below.

Pick a provider per server in the dashboard under **AI Chat**, or set a
process-wide default with the environment variable. Setup steps for each key
live in [SETUP_GUIDE.md](SETUP_GUIDE.md#ai-integration).

## The providers

| Provider | Default model | Credential | Cost estimates | Notes |
| --- | --- | --- | --- | --- |
| **OpenAI** | `gpt-4o-mini` | `OPENAI_API_KEY` | Yes | GPT-4o, GPT-4.1, o1 and o3 families |
| **Gemini** | `gemini-2.0-flash` | `GEMINI_API_KEY` | Yes | Has a free tier; Flash models are the cheap end |
| **Claude** | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` | Yes | The only provider that can call [MCP servers](README.md#mcp-servers-anthropic-only) |
| **Ollama** | `llama3.2` | `OLLAMA_BASE_URL` | Always $0 | Runs on your own hardware; no key, no per-token cost |
| **OpenRouter** | `openai/gpt-4o-mini` | `OPENROUTER_API_KEY` | No | One key, many vendors' models; names must be `vendor/model` |

## What actually differs

**MCP tool use is Anthropic-only.** If you want the bot to reach a GitHub repo,
a calendar, or an internal search through
[MCP](https://modelcontextprotocol.io), Claude is the only option — the other
four providers ignore MCP configuration entirely.

**Cost tracking depends on a pricing table.** `estimateCost` in
`src/services/ai/usage.js` matches the model name against the provider's
`pricing` array. OpenAI, Gemini and Claude carry per-model rates, so the
dashboard shows spend. Ollama is pinned at zero. OpenRouter ships an empty
table because its catalogue spans many vendors, so token counts are recorded
but the dashboard shows no dollar figure for it.

**OpenRouter validates model names.** A model without a `/` is rejected before
the request goes out, because OpenRouter addresses everything as
`vendor/model`.

**Ollama's base URL is guarded.** A per-server URL set in the dashboard must be
an `http(s)` address that does not resolve into private or reserved space —
otherwise a server admin could aim the bot at anything reachable from its
container. The operator's own endpoint is exempt: set it as `OLLAMA_BASE_URL`.

## Rough guidance

- **Trying it out** — Gemini. The free tier is generous enough to exercise the
  bot without a card on file.
- **General use, paying by the token** — the defaults are chosen to be cheap.
  `gpt-4o-mini` and `gemini-2.0-flash` are the low-cost tiers of their
  families; move up a tier only if answers are visibly weak.
- **Tool use** — Claude, for MCP.
- **Private or zero-cost** — Ollama. Nothing leaves your network, and quality
  tracks whatever model you can host.
- **Comparing models often** — OpenRouter, so you can switch vendors by editing
  a model name rather than provisioning another key. Accept that you lose
  dashboard cost figures.

## Pricing

Token prices move, so this file does not restate them. The rates the bot uses
for its own estimates are the `pricing` arrays in each provider module; the
vendors' current numbers are at:

- [OpenAI](https://openai.com/api/pricing/)
- [Google Gemini](https://ai.google.dev/pricing)
- [Anthropic](https://www.anthropic.com/pricing)
- [OpenRouter](https://openrouter.ai/models) (per-model)

If a vendor changes a rate, update that provider's `pricing` array — the
dashboard's spend figures come from it, not from this document.
