/**
 * Repair malformed jina tool-call arguments before they reach the session.
 *
 * dsh's DeepSeek adapter parses each tool_use `partial_json` when the stream
 * closes. If that parse fails it throws MALFORMED_RESPONSE and the whole turn
 * dies, even though the tool never ran. The failure comes from the model, not
 * from the harness: the gateway's own copy of the response carries the same
 * broken bytes.
 *
 * The damage is narrow in practice. Across 62 tools only read_url and
 * search_web declare a required parameter as `anyOf: [string, array]`, and
 * nearly every broken sample is one of those two strings losing its quotes:
 *
 *     {"url": https://example.com}
 *
 * Flattening those schemas to `string` would fix the symptom but drop the
 * multi-value form (up to five URLs or queries in one call), so this plugin
 * repairs the stream instead and leaves the schema alone.
 *
 * A tool-call block-end is held until `finish` arrives. Blocks are small and
 * adjacent to finish, so the delay is invisible. Text and reasoning deltas
 * pass through untouched.
 *
 * The error is only swallowed when every tool-call block in the message ends
 * up valid. If any block cannot be repaired, the original failure goes out
 * unchanged and the normal retry policy takes over. Executing a tool with
 * arguments nobody validated is the one outcome worth avoiding.
 *
 * A repaired turn loses its replayState, so its thinking blocks go back to the
 * provider without a signature. DeepSeek accepts unsigned thinking (verified
 * HTTP 200), so this is safe.
 */

import { jsonrepair } from "jsonrepair";

export const name = "jina-json-repair";

/** Tools to repair, matched by the part after `server__`; others are left alone. */
const DEFAULT_TOOLS = ["read_url", "search_web"];

const INVALID_TOOL_JSON = "tool input is invalid JSON";

function toolSuffix(fullName) {
	return fullName.includes("__") ? fullName.slice(fullName.lastIndexOf("__") + 2) : fullName;
}

function toolMatches(fullName, patterns) {
	const short = toolSuffix(fullName);
	return patterns.some((pattern) => pattern === fullName || pattern === short);
}

function uriParses(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Check one value against a JSON Schema fragment.
 *
 * jsonrepair will happily wrap garbage in quotes, so a bare "did it parse"
 * check is not enough. Types and `format: "uri"` are both enforced here,
 * which is what stops `{"url": <<<junk>>>}` from becoming a real URL.
 */
function valueMatches(value, schema) {
	if (schema === undefined) return true;
	if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
		return schema.anyOf.some((branch) => valueMatches(value, branch));
	}
	switch (schema?.type) {
		case undefined:
			return true;
		case "integer":
			return Number.isInteger(value);
		case "number":
			return Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			if (typeof value !== "string") return false;
			return schema.format === "uri" ? uriParses(value) : true;
		case "object":
			return acceptable(value, schema);
		case "array": {
			if (!Array.isArray(value)) return false;
			const min = schema.minItems ?? 1;
			if (value.length < min) return false;
			if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
			return value.every((item) => valueMatches(item, schema.items));
		}
		default:
			return typeof value === schema.type;
	}
}

/**
 * Required keys present, declared properties type-correct, and no key the
 * schema does not declare.
 *
 * The unknown-key rule matters because jsonrepair reads a bare `:` as a key
 * separator and `//` as a line comment. `{"url": https://a.com, https://b.com}`
 * repairs to `{"url":"https://a.com","https":null}`, and a `site:github.com`
 * filter inside a query becomes a separate `site` property. Accepting either
 * would execute a tool call with silently mangled arguments.
 *
 * A missing schema rejects everything: there is nothing to validate against,
 * so the turn should fail rather than run a tool unvalidated.
 */
function acceptable(value, schema) {
	if (schema === undefined || schema === null || typeof schema !== "object") return false;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (Array.isArray(schema.required)) {
		for (const key of schema.required) if (!(key in value)) return false;
	}
	const properties = schema.properties;
	if (properties === undefined || typeof properties !== "object") {
		return schema.additionalProperties === true;
	}
	for (const key of Object.keys(value)) {
		const declared = properties[key];
		if (declared === undefined) {
			if (schema.additionalProperties !== true) return false;
			continue;
		}
		if (!valueMatches(value[key], declared)) return false;
	}
	return true;
}

/** Repaired argument text, or undefined when the block cannot be trusted. */
export function repairArguments(raw, schema) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (parsed !== undefined && acceptable(parsed, schema)) return JSON.stringify(parsed);

	let repaired;
	try {
		repaired = JSON.parse(jsonrepair(raw));
	} catch {
		return undefined;
	}
	if (!acceptable(repaired, schema)) return undefined;
	return JSON.stringify(repaired);
}

/**
 * Wrap a chunk stream, repairing malformed jina tool-call arguments.
 *
 * @param inner - chunk stream produced by the DeepSeek adapter.
 * @param options - the request; `tools` supplies schemas for validation.
 * @param config - `{ tools?: string[] }`, overriding the default target list.
 * @param log - diagnostic sink, silent by default.
 */
export async function* repairStream(inner, options, config = {}, log = () => {}) {
	const patterns = Array.isArray(config.tools) && config.tools.length > 0 ? config.tools : DEFAULT_TOOLS;
	// Exact names first, then the suffix after `server__`. The MCP server name
	// is a deployment detail; a renamed server should still find its schema.
	const schemas = new Map();
	const bySuffix = new Map();
	for (const tool of options?.tools ?? []) {
		if (!tool?.name) continue;
		schemas.set(tool.name, tool.parameters);
		const suffix = toolSuffix(tool.name);
		if (!bySuffix.has(suffix)) bySuffix.set(suffix, tool.parameters);
	}
	const schemaFor = (toolName) => schemas.get(toolName) ?? bySuffix.get(toolSuffix(toolName));

	const held = new Map();
	const flush = function* () {
		for (const chunk of held.values()) yield chunk;
		held.clear();
	};

	try {
		for await (const chunk of inner) {
			if (chunk?.type === "block-end" && chunk.block?.type === "tool-call") {
				held.set(chunk.index, chunk);
				continue;
			}
			if (chunk?.type !== "finish") {
				yield chunk;
				continue;
			}

			const failure = chunk.reason?.kind === "error" ? chunk.reason.failure : undefined;
			const repairable =
				failure?.code === "MALFORMED_RESPONSE" &&
				String(failure.message ?? "").includes(INVALID_TOOL_JSON) &&
				held.size > 0;

			if (repairable) {
				const repaired = new Map();
				let ok = true;
				for (const [index, entry] of held) {
					const toolName = entry.block.name ?? "";
					let args = entry.block.arguments ?? "";
					if (toolMatches(toolName, patterns)) {
						const fixed = repairArguments(args, schemaFor(toolName));
						if (fixed === undefined) {
							ok = false;
							log(`cannot repair ${toolName}`);
							break;
						}
						args = fixed;
					} else {
						// Not ours to repair. It may ride along only if the adapter
						// would have accepted it too: valid JSON *and* a plain object.
						let parsed;
						try {
							parsed = JSON.parse(args);
						} catch {
							parsed = undefined;
						}
						if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
							ok = false;
							log(`no repair offered for ${toolName}`);
							break;
						}
					}
					repaired.set(index, { ...entry, block: { ...entry.block, arguments: args } });
					if (toolMatches(toolName, patterns)) log(`repaired ${toolName}`);
				}
				if (ok) {
					for (const entry of repaired.values()) yield entry;
					held.clear();
					yield { type: "finish", reason: { kind: "tool-calls" } };
					return;
				}
				log("repair abandoned; passing the original error through");
			}

			yield* flush();
			yield chunk;
			return;
		}
	} catch (error) {
		// The producer failed rather than a tool call being malformed. Release
		// whatever was held so the attempt records a complete stream, then let
		// the failure through. A consumer-side abort needs no release: dsh drops
		// tool-call blocks from an interrupted message anyway.
		yield* flush();
		throw error;
	}
}

/**
 * Mount on the `llm/stream` waterfall.
 *
 * @param ctx - cordis plugin context.
 * @param config - `{ tools?: string[] }`.
 */
export function apply(ctx, config = {}) {
	ctx.on("llm/stream", (options, next) => {
		const inner = next();
		if (inner === undefined || typeof inner[Symbol.asyncIterator] !== "function") return inner;
		return repairStream(inner, options, config, (message) => ctx.logger?.info?.(`jina-json-repair: ${message}`));
	});
}
