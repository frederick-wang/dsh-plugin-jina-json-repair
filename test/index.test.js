import assert from "node:assert/strict";
import test from "node:test";
import { repairStream } from "../src/index.js";

const stream = (chunks) =>
	(async function* () {
		for (const chunk of chunks) yield chunk;
	})();

const readUrl = {
	name: "jina__read_url",
	parameters: {
		type: "object",
		required: ["url"],
		properties: {
			url: {
				anyOf: [
					{ type: "string", format: "uri" },
					{ type: "array", items: { type: "string", format: "uri" }, minItems: 1, maxItems: 5 },
				],
			},
			question: { type: "string" },
			topk: { type: "integer" },
		},
	},
};

const searchWeb = {
	name: "jina__search_web",
	parameters: {
		type: "object",
		required: ["query"],
		properties: {
			query: {
				anyOf: [
					{ type: "string" },
					{ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
				],
			},
			num: { type: "integer" },
		},
	},
};

const bash = {
	name: "bash",
	parameters: { type: "object", required: ["command"], properties: { command: { type: "string" } } },
};

const options = { tools: [readUrl, searchWeb, bash] };

const badFinish = {
	type: "finish",
	reason: {
		kind: "error",
		failure: {
			code: "MALFORMED_RESPONSE",
			message: "DeepSeek Messages stream: tool input is invalid JSON",
		},
	},
};

const toolEnd = (index, name, args) => ({
	type: "block-end",
	index,
	block: { type: "tool-call", id: `call_${index}`, name, arguments: args },
});

async function collect(chunks, opts = options, config = {}) {
	const out = [];
	for await (const chunk of repairStream(stream(chunks), opts, config, () => {})) out.push(chunk);
	return out;
}

test("a healthy stream comes out byte for byte", async () => {
	const chunks = [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text: "hello" },
		{ type: "block-end", index: 0, block: { type: "text", text: "hello" } },
		toolEnd(1, "jina__read_url", '{"url":"https://example.com"}'),
		{ type: "finish", reason: { kind: "tool-calls" } },
	];
	assert.deepEqual(await collect(chunks), chunks);
});

test("repairs an unquoted url and resumes the turn", async () => {
	const chunks = [
		toolEnd(0, "jina__read_url", '{"question": "what is this?", "topk": 3, "url": https://example.com/a}'),
		badFinish,
	];
	const out = await collect(chunks);
	const finish = out.at(-1);
	assert.equal(finish.type, "finish");
	assert.equal(finish.reason.kind, "tool-calls");
	const block = out.find((chunk) => chunk.type === "block-end");
	assert.deepEqual(JSON.parse(block.block.arguments), {
		question: "what is this?",
		topk: 3,
		url: "https://example.com/a",
	});
});

test("repairs an unquoted search query", async () => {
	const out = await collect([
		toolEnd(0, "jina__search_web", '{"query": Bun official docs, "num": 10}'),
		badFinish,
	]);
	assert.equal(out.at(-1).reason.kind, "tool-calls");
	assert.deepEqual(JSON.parse(out.find((chunk) => chunk.type === "block-end").block.arguments), {
		query: "Bun official docs",
		num: 10,
	});
});

test("keeps the original error when a target block cannot be repaired", async () => {
	const chunks = [toolEnd(0, "jina__read_url", '{"url": <<<junk>>> }'), badFinish];
	assert.deepEqual(await collect(chunks), chunks);
});

test("keeps the original error when a non-target block is malformed", async () => {
	const chunks = [
		toolEnd(0, "jina__read_url", '{"url": https://example.com}'),
		toolEnd(1, "bash", '{"command": ls -la}'),
		badFinish,
	];
	assert.deepEqual(await collect(chunks), chunks);
});

test("repairs a target block while a healthy non-target block rides along", async () => {
	const out = await collect([
		toolEnd(0, "jina__read_url", '{"url": https://example.com}'),
		toolEnd(1, "bash", '{"command":"ls -la"}'),
		badFinish,
	]);
	assert.equal(out.at(-1).reason.kind, "tool-calls");
	assert.equal(out.filter((chunk) => chunk.type === "block-end").length, 2);
});

test("refuses a value that is not a parseable uri", async () => {
	const chunks = [toolEnd(0, "jina__read_url", '{"url": not a url}'), badFinish];
	assert.deepEqual(await collect(chunks), chunks);
});

test("refuses a repaired object missing a required key", async () => {
	const chunks = [toolEnd(0, "jina__read_url", '{"question": oops }'), badFinish];
	assert.deepEqual(await collect(chunks), chunks);
});

test("leaves other tools alone even when they are the only broken one", async () => {
	const chunks = [toolEnd(0, "bash", '{"command": ls -la}'), badFinish];
	assert.deepEqual(await collect(chunks), chunks);
});

test("preserves block order across several tool calls", async () => {
	const out = await collect([
		toolEnd(0, "jina__read_url", '{"url":"https://a.example"}'),
		toolEnd(1, "jina__search_web", '{"query": hello there}'),
		badFinish,
	]);
	assert.deepEqual(
		out.filter((chunk) => chunk.type === "block-end").map((chunk) => chunk.index),
		[0, 1],
	);
	assert.equal(out.at(-1).reason.kind, "tool-calls");
});

test("honours a custom tools list", async () => {
	const chunks = [toolEnd(0, "bash", '{"command": ls}'), badFinish];
	const out = await collect(chunks, options, { tools: ["bash"] });
	assert.equal(out.at(-1).reason.kind, "tool-calls");
	assert.deepEqual(JSON.parse(out[0].block.arguments), { command: "ls" });
});

test("flushes held blocks and rethrows when the stream dies", async () => {
	const dying = (async function* () {
		yield toolEnd(0, "jina__read_url", '{"url":"https://example.com"}');
		throw new Error("upstream died");
	})();
	const seen = [];
	await assert.rejects(async () => {
		for await (const chunk of repairStream(dying, options, {}, () => {})) seen.push(chunk);
	}, /upstream died/);
	assert.equal(seen.length, 1);
});

test("an empty tool list falls back to the defaults", async () => {
	const out = await collect([toolEnd(0, "jina__search_web", '{"query": hi}'), badFinish], options, { tools: [] });
	assert.equal(out.at(-1).reason.kind, "tool-calls");
});
