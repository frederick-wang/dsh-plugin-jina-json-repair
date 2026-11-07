# dsh-plugin-jina-json-repair

[English](README.md) | [中文](README.zh.md)

修复 jina MCP 工具 `read_url` 和 `search_web` 的畸形 tool-call 参数，在 dsh 把它们写进会话之前拦下来，一次坏调用不再报废整个 turn。

## 问题

dsh 的 DeepSeek 适配器在流结束时逐个解析 `tool_use` 块。累积的 `partial_json` 不是合法 JSON 时，它抛 `MALFORMED_RESPONSE: DeepSeek Messages stream: tool input is invalid JSON`，整个 turn 就此结束，工具根本没跑。

坏字节是模型吐出来的，不是 dsh 拼的。网关自己存的那份响应里也是同样的损坏。典型样本：

```
{"url": https://example.com/a}
```

字符串值两边的引号直接没了。

在本机一个装了 62 个工具的 profile 里，只有 `read_url` 和 `search_web` 把必填参数声明成 `anyOf: [string, array]`，而几乎所有坏样本都落在这两个参数上。把 schema 拍平成 `string` 能解决表面问题，但会丢掉多值形式：一次读最多 5 个 URL，或一次搜 5 个 query。这个插件保留 schema，改在流这一层修。

## 安装

```bash
dsh plugin --profile dsh-tui add github:frederick-wang/dsh-plugin-jina-json-repair
```

`dsh plugin add` 会装进 profile 的 `node_modules`。因为包里声明了 `dsh.bundle.patch`，它还会把包名自动追加到 `dsh.profile.bundles`，包内的 `cordis.patch.yml` 负责挂载插件。

用本地 checkout 也可以：

```bash
dsh plugin --profile dsh-tui add ./dsh-plugin-jina-json-repair
```

装完重启 dsh。插件在启动时挂载。

## 做了什么

插件监听 `llm/stream` 这个 waterfall，也就是 provider 适配器和会话日志之间的接缝。它把每个 tool-call 的 `block-end` 扣住，等 `finish` 到了再一起放行。文本和思考的 delta 全程直通，正常流式输出不受影响。

`finish` 是 `MALFORMED_RESPONSE` 且消息里带 tool-input 那句时，它对目标工具扣住的参数跑 `jsonrepair`，再用请求自带的 schema 验一遍：

- 必填键都在
- 声明过的属性类型对
- `format: "uri"` 的值是 http 或 https
- 数组非空
- 不出现 schema 没声明的键

最后一条是 `jsonrepair` 老实的关键。它把裸冒号当对象键分隔符、把 `//` 当行注释，所以 `{"url": https://a.com, https://b.com}` 会被修成 `{"url":"https://a.com","https":null}`，第二个 URL 就这么没了。query 里的 `site:github.com` 会变成一个独立的 `site` 属性。这两种结果都能通过"能不能 parse"这种粗检，但都会拿被改坏的参数去执行工具，所以直接拒绝。

全部验过，才放出修好的块，补一个 `finish: tool-calls`，turn 继续跑。任何一项不过，原始错误原样透出，交给 dsh 自己的重试策略。请求里没有某个工具的 schema 时也不修，因为没有东西可以验。

## 配置

默认修 `["read_url", "search_web"]`，按工具名里 `server__` 之后的部分匹配。要改就在 profile 的 `cordis.patch.yml` 里覆盖这一行：

```yaml
- id: jina-json-repair
  config:
    tools:
      - read_url
      - search_web
      - search_arxiv
```

列表为空或没写就回到默认值。加进去的工具只有参数能通过它自己的 schema 校验才会被修，所以扩大名单不会放大能通过的东西。

## 已知限制

修复过的 turn 会丢 `replayState`，那一轮的 thinking 块下次回传时没有 signature。DeepSeek 收不带 signature 的 thinking，后续轮次正常，只是那段推理不会被原样重放。

插件修语法，不修语义。模型把必填字段整个漏掉时没什么可修的，错误照旧透出。修好的 `search_web` query 也可能只是恰好合法的胡话，搜索出来自然没用。

扣住 block-end 会让 UI 里的工具调用晚一点显示，最多几百毫秒，因为工具调用本来就挨着 finish。

## 开发

```bash
pnpm install
pnpm test
```

21 个测试覆盖直通、修复、拒绝、顺序、中断、schema 查找和自定义名单。用的是 Node 自带的测试运行器，不需要访问 provider。

要对着真实 provider 试，把 `DEEPSEEK_BASE_URL` 指向一个会吐坏 `input_json_delta` 的本地服务，然后比较挂插件和不挂的差别。最小 fixture 几十行 `node:http` 就够。

## License

MIT
