# dsh-plugin-jina-json-repair

Repairs malformed tool-call arguments from the jina MCP tools `read_url` and `search_web` before dsh persists them, so one bad tool call no longer kills the turn.

## The problem

dsh's DeepSeek adapter parses each `tool_use` block when the stream closes. If the accumulated `partial_json` is not valid JSON, it throws `MALFORMED_RESPONSE: DeepSeek Messages stream: tool input is invalid JSON` and the whole turn ends. The tool never ran.

The bad bytes come from the model, not from dsh. The gateway's own copy of the response has the same damage. A typical sample:

```
{"url": https://example.com/a}
```

The quotes around the string value are simply missing.

Across 62 tools in one profile, only `read_url` and `search_web` declare their required parameter as `anyOf: [string, array]`, and almost every broken sample is one of those two. Flattening the schema to `string` fixes the symptom but loses the multi-value form: up to five URLs or five queries in one call. This plugin keeps the schema and repairs the stream instead.

## Install

```bash
dsh plugin --profile dsh-tui add github:frederick-wang/dsh-plugin-jina-json-repair
```

`dsh plugin add` installs into the profile's `node_modules` and, because this package declares `dsh.bundle.patch`, appends it to `dsh.profile.bundles` automatically. The bundled `cordis.patch.yml` mounts the plugin.

For a local checkout:

```bash
dsh plugin --profile dsh-tui add ./dsh-plugin-jina-json-repair
```

Restart dsh afterwards. Plugins mount at boot.

## What it does

The plugin listens on the `llm/stream` waterfall, the seam between the provider adapter and the session log. It holds each tool-call `block-end` until `finish` arrives. Text and reasoning deltas pass through immediately, so normal streaming is unaffected.

When the finish is `MALFORMED_RESPONSE` with the tool-input message, it runs `jsonrepair` on the held arguments of each target tool and validates the result against the schema from the request:

- required keys are present
- declared property types match
- `format: "uri"` values use http or https
- arrays are non-empty
- no key appears that the schema does not declare

That last rule is what keeps `jsonrepair` honest. It treats a bare colon as a key separator and `//` as a line comment, so `{"url": https://a.com, https://b.com}` repairs to `{"url":"https://a.com","https":null}`, dropping the second URL. A `site:github.com` filter inside a query becomes a separate `site` property. Both pass a naive "did it parse" check and both would execute a tool call with mangled arguments, so they are rejected.

If everything validates, the repaired blocks are released with a synthetic `finish: tool-calls` and the turn continues. Otherwise the original error goes out untouched and dsh's normal retry policy takes over. When the request carries no schema for a tool, nothing is repaired: there is nothing to validate against.

The error is only swallowed when every tool-call block in the message ends up valid. A malformed `bash` block next to a repairable `read_url` block still aborts, because executing a tool with arguments nobody validated is worse than retrying.

## Configuration

The default target list is `["read_url", "search_web"]`, matched by the part after `server__` in the tool name. To change it, override the row in your profile's `cordis.patch.yml`:

```yaml
- id: jina-json-repair
  config:
    tools:
      - read_url
      - search_web
      - search_arxiv
```

An empty or missing list falls back to the defaults. Any tool named there is repaired only if its arguments validate against its own schema, so adding a tool does not widen what gets through.

## Known limitations

Repairing a turn drops its `replayState`, so that turn's thinking blocks go back to the provider without a signature. DeepSeek accepts unsigned thinking, so subsequent turns work; the earlier reasoning simply does not get replayed word for word.

The plugin repairs syntax, not meaning. If the model omits a required field entirely, there is nothing to repair and the error passes through. A repaired `search_web` query can still be nonsense text that happens to be valid JSON; the search then returns nothing useful.

Holding block-ends delays the tool-call display in the UI until the stream closes. That is a few hundred milliseconds at most, since tool calls sit next to the finish chunk.

## Development

```bash
npm install
npm test
```

Twenty-one tests cover passthrough, repair, refusal, ordering, aborts, schema lookup, and custom target lists. The suite uses Node's built-in runner and needs no provider access.

To test against a real provider, point `DEEPSEEK_BASE_URL` at a local server that emits a broken `input_json_delta` and compare with and without the plugin mounted. A minimal fixture is a few dozen lines of `node:http`.

## License

MIT
