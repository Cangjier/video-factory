# narrate / gen 家族功能拆解

> 只读拆解。所有结论都可在标注的 `file:line` 处复核；代码里证不实的写「未证实」并给位置。
> 涉及文件：`src/tools/narrate.mjs`、`src/tools/narrate-actions.mjs`、`src/tools/gen.mjs`、
> `src/tools/gen-actions.mjs`、`src/core/tts.mjs`、`src/core/srt.mjs`、`src/core/transcribe.mjs`、
> `src/core/ark.mjs`、`index.mjs`（配置默认值）。

## 工具 video_narrate

**一句话定位**：把旁白文案变成 MP3 + 逐词时间戳，再把时间戳推导成字幕条、SRT 文件和烧录样式数值；外加一个「把已有音视频转成文字」的本地识别入口。

**何时用**：需要配音（`synthesize`）、需要字幕（`to_cues` → `srt_write` → `layout`）、需要把已有成片的台词读出来（`transcribe`）、需要与外部 SRT 互操作（`srt_read`）。

**何时不该用**：
- 不要用 `transcribe` 换逐词时间戳——宿主识别是**整句级**，只有全文没有词级时间（README:108）；逐词精度只能来自 `synthesize`。
- 不要指望它做**多说话人/对白播客**配音：本工具走 Edge 朗读（`src/core/tts.mjs:25`），没有任何 speaker 概念。`docs/豆包语音播客-API契约.md` 记录的播客协议（`action: 3` 逐行指定 speaker，见该文档第 318–352、546–565 行）**没有被任何代码引用**（全仓 `podcast|sami|openspeech` 只命中该文档），不要把它当成这个工具的能力说明。
- 不要在纯计算步骤（断句/排版）上重复调用 `synthesize`：再造一次要联网、要花时间（`src/tools/narrate.mjs:5-8`、`src/tools/narrate-actions.mjs:3-8`）。
- 商用配音不要用它：Edge 朗读的商用授权未明确（`src/core/tts.mjs:15-17`，README:93）——但这是文档判断，不是代码约束。

### action 总览与全量 schema 字段表

`action` 必填、枚举六个值（`src/tools/narrate.mjs:28`）。下表的「含义」列用【动作名】标出该字段**只对哪个 action 有效**；未标动作的字段对所有动作都无副作用（schema 层允许传，代码层不读）。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 六个之一：`synthesize` / `to_cues` / `srt_write` / `srt_read` / `layout` / `transcribe`（`src/tools/narrate.mjs:28`）。未知值报 `unknown action ...`（`src/tools/shared.mjs:87-89`） |
| text | string | 否 | — | 【synthesize】内联旁白文案。与 `textPath` 二选一；**同时给出时 `text` 优先**（`src/tools/narrate-actions.mjs:75-82`）。空白视为未给（:83-85） |
| textPath | string | 否 | — | 【synthesize】从该 UTF-8 文件读文案；**只有 `text` 为空时才读**（:76）。文件读取后剥掉 BOM（:81）。文件不存在报 `找不到文案文件` |
| outDir | string | 否 | `<cwd>/narration` | 【synthesize】输出目录，相对 `cwd` 解析；不存在会递归创建（:87-91）。固定写 `voiceover.mp3` + `voiceover.words.json` |
| voice | string | 否 | 配置 `tts.voice` = `zh-CN-XiaoxiaoNeural` | 【synthesize】Edge TTS 声音短名（`src/core/tts.mjs:52`、`index.mjs:98`）。传任意字符串、不做白名单校验 |
| rate | string | 否 | 配置 `tts.rate` = `+0%` | 【synthesize】语速增量，如 `+10%` / `-15%`；原样进 SSML `prosody rate`（`src/core/tts.mjs:121-129`、`index.mjs:99`） |
| pitch | string | 否 | 配置 `tts.pitch` = `+0Hz` | 【synthesize】音高增量，如 `-2Hz`；进 SSML `prosody pitch`（`index.mjs:100`） |
| volume | string | 否 | 配置 `tts.volume` = `+0%` | 【synthesize】音量增量；进 SSML `prosody volume`（`index.mjs:101`） |
| audioPath | string | 否* | — | 【transcribe】要转录的音视频文件，相对 `cwd` 解析。**本 action 的必需项**（:238-240） |
| language | string enum | 否 | `auto` | 【transcribe】`auto` / `zh` / `en` / `yue` / `ja` / `ko`。`auto` 在代码里被转成「不传 language」交给识别器自动判断（:273） |
| maxAudioSeconds | integer | 否 | 131 | 【transcribe】单次识别请求的秒数预算，用于换算 `maxAudioBytes`（:252-253）。默认值由 `floor(4 MiB / 32000 B/s)` 得出（:22-23、`src/core/transcribe.mjs:28,31`） |
| wordsPath | string | 否 | 上一次 `synthesize` 的输出 | 【to_cues】逐词时间戳 JSON；显式路径优先于记忆值（:37-41）；都没有报 `没有可用的逐词时间戳`。文件里可以是数组，也可以是 `{words:[...]}`（:49） |
| maxChars | integer | 否 | 18 | 【to_cues / layout】每行字数上限。`to_cues` 用它断句兼折行（:135）；`layout` 把它写进 `max_chars_per_line`（:200）。plan.json 侧合法区间 4–80（`src/core/plan.mjs:352-355`） |
| cuesPath | string | 否 | 上一次 `to_cues` 的输出 | 【srt_write / layout】字幕条 JSON；显式路径优先（:52-56）。文件里可以是数组，也可以是 `{cues:[...]}`（:64） |
| srtPath | string | 否 | — | 【srt_read】**必需**（:170-172）；【srt_write】可选，默认 `dirname(cuesPath)/voiceover.srt`（:156-159） |
| scale | number | 否 | — | 【layout】把每条字幕时间乘该系数，并把结果**另存**为 `voiceover.scaled.cues.json`（:209-216）。只在 `>0` 且 `≠1` 时生效 |
| canvasWidth | integer | 否 | 1080 | 【layout】画布宽，用于算字号（:187、191、195） |
| canvasHeight | integer | 否 | 1920 | 【layout】画布高，用于算下边距（:188、196） |
| cwd | string | 否 | 插件项目根 → 进程工作目录 | 所有相对路径的解析基准（`src/tools/shared.mjs:28-32,100-104`） |

> *schema 层只有 `action` 是 `required`（`src/tools/shared.mjs:80-81`），其余「必填」都是**代码路径上的必需**，缺了会抛 `VideoFactoryError`。

### 共用行为（六个 action 通用的、必须先知道的事实）

- **记忆上一次输出**：`lastWordsPath` / `lastCuesPath` / `lastStyle` 是 `createNarrateActions` 闭包里的变量（`src/tools/narrate-actions.mjs:33-35`），在插件注册时创建一次（`src/tools/index.mjs:63`），因此**跨调用、跨会话、进程内共享**，不是会话级状态。其中 `lastStyle` 只被写、**从未被任何 action 读**（:215、:222 是仅有的两处赋值），真正被复用为默认输入的只有 `lastWordsPath`（`to_cues`）与 `lastCuesPath`（`srt_write`、`layout`）。
- **文件名是固定的**：`voiceover.mp3` / `voiceover.words.json`（:92-93）、`voiceover.cues.json`（:136）、`voiceover.srt`（:159）、`voiceover.scaled.cues.json`（:211）。同一目录再跑一次就**覆盖**。
- **纯计算三步不要钱**：`to_cues` / `layout` / `srt_*` 只做算术与文件读写，不联网、不调 ffmpeg（`src/core/srt.mjs:1-17`）。
- **一次合成 = 一份音频 + 一份词表**：逐词时间的唯一来源是 Edge 自动播报服务返回的 `WordBoundary` 元数据，不是强制对齐（`src/core/tts.mjs:200-209`）。

### action: synthesize

- **用途**：文案 → `voiceover.mp3` + `voiceover.words.json`（含 `duration` 与逐词 `{text,start,end}`）。
- **参数**：`action`、`text`、`textPath`、`outDir`、`voice`、`rate`、`pitch`、`volume`、`cwd`（含义见总表；其余字段传入被忽略）。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `synthesize` |
| text | string | 二选一 | — | 内联文案；优先于 `textPath` |
| textPath | string | 二选一 | — | 文案文件（UTF-8，自动剥 BOM） |
| outDir | string | 否 | `<cwd>/narration` | 输出目录 |
| voice | string | 否 | `zh-CN-XiaoxiaoNeural` | Edge TTS 声音短名 |
| rate / pitch / volume | string | 否 | `+0%` / `+0Hz` / `+0%` | SSML prosody 增量 |
| cwd | string | 否 | 见总表 | 路径基准 |

- **行为细节**：
  - **不需要任何 Key**（`src/core/tts.mjs:1-7`）。它连的是微软 Edge「大声朗读」端点 `wss://speech.platform.bing.com/.../readaloud/edge/v1`（:25），用公开的 trusted client token（:28）和一个按 300 秒窗口计算的 `Sec-MS-GEC` 签名（:74-78）；Origin 伪装成 Edge 扩展（:37）。用一个自写的 WebSocket 客户端发请求，因为该服务要求 `Origin` + `Cookie`，Node 内置 `WebSocket` 设不了（`src/core/ws.mjs:1-14`）。
  - **逐词时间的来源**：握手时 `speech.config` 显式开启词边界（`wordBoundaryEnabled: "true"`，`sentenceBoundaryEnabled: "false"`，`src/core/tts.mjs:291-293`），音频格式固定 `audio-24khz-48kbitrate-mono-mp3`（:40）。服务端推 `audio.metadata` 帧，取 `Metadata[].Type === 'WordBoundary'` 的 `Data.text.Text` 与 `Offset`/`Duration`（100ns 刻度，除以 1e7 得秒）（:192-211）。
  - **音频与时间轴的关系**：`duration` = **最后一个词的 end**，不是 MP3 真实时长（`src/core/tts.mjs:316`）；尾部静音不计入。
  - **文本处理**：先 `trim()`（:244），空文本抛 `旁白文本为空，无法合成语音`（:241-243）；字符按 XML 转义进 SSML（:101-110、121-129）。
  - **整段合成、单连接**：一次连接出一整段，`turn.end` 结束（:310-317）；MP3 分片按 MPEG 同步字定位（:169-181，注释记录了 2026-10-04 起帧头长度语义变化导致的丢帧问题）。
  - **超时**：默认 60000 ms，同时用作握手超时和整体合成超时（:55、:280；握手默认 15 s，`src/core/ws.mjs:42,133,174`）。
  - **代理**：走系统代理时通过 CONNECT 隧道建连（`src/core/ws.mjs:315-331`、`src/core/proxy.mjs`），这是修过的坑（README:428）。
- **输出**：`{ audio, wordsPath, duration, wordCount, firstWords, planFragment: { voiceover } }`（`src/tools/narrate-actions.mjs:116-123`）。磁盘上的 `voiceover.words.json` 形如 `{ audio, duration, words:[{text,start,end}] }`（:110-112）。`duration` 保留 3 位小数，`firstWords` 是前 5 个词的 `文本@起点秒`。
- **代价**：联网（微软端点，非方舟、不花 API 钱）；墙钟时间≈音频时长 + 握手；**60 秒硬上限**——文案长到念出来超过 60 秒就会超时失败。无宿主服务依赖。
- **失败与陷阱**：
  - `配音失败：Edge TTS 合成超时（60000ms）`／`Edge TTS 连接失败：...`／`Edge TTS 在 turn.end 之前关闭了连接`／`Edge TTS 未返回任何音频数据`（`src/core/tts.mjs:280-284,311-313`，动作层前缀 `配音失败：`，`src/tools/narrate-actions.mjs:105`）。
  - 只有 `text` 为空才会读 `textPath`：两个都传而 `text` 非空时，文件被静默忽略。
  - `textPath` 相对路径按 `cwd` 解析。
  - 重跑会**静默覆盖** `voiceover.mp3` 与 `voiceover.words.json`（同一 outDir 时）。
  - **未证实**：声音名拼错时服务端的确切报错文案（代码只透传 `error.message`）；中文 voice 之外的质量差异无代码依据。
- **典型用法**：
  ```json
  { "action": "synthesize", "textPath": "narration/script.txt", "outDir": "narration", "rate": "-5%" }
  ```
- **相邻动作**：输出 `wordsPath` 自动记为「上一次逐词时间戳」，可直接 `{"action":"to_cues"}`；音频路径塞进 `plan.json` 的 `audio.voiceover`（返回里的 `planFragment.voiceover`，`src/core/plan.mjs:321`）。

### action: to_cues

- **用途**：逐词时间戳 → 字幕条（含断句、折行、相邻重复去重、从 1 重新编号），写 `voiceover.cues.json`。
- **参数**：`action`、`wordsPath`、`maxChars`、`cwd`。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `to_cues` |
| wordsPath | string | 否 | 上一次 `synthesize` 的 `voiceover.words.json` | 逐词时间戳文件；数组或 `{words}` 都接受（`src/tools/narrate-actions.mjs:49`） |
| maxChars | integer | 否 | 18 | 每行字数上限，同时参与「累计字数到上限就收一条」的断句（:135；`src/core/srt.mjs:141,178`） |
| cwd | string | 否 | 见总表 | 路径基准 |

- **行为细节**（全部来自 `src/core/srt.mjs`，纯函数、可离线对拍）：
  - **断句四条规则**，任一命中就收一条（:176-182）：① 当前词最后一个字符属于句末标点 `。！？!?…；;`（:33、67-70）；② 本条累计字数 `>= maxChars`；③ 与下一个词的静音 `pause >= 0.45s`（默认 `DEFAULT_GAP_BREAK`，:45）；④ 本条已持续 `>= 6.0s`（默认 `DEFAULT_MAX_DURATION`，:42）；输入结束剩下的词也收一条。
  - **`gapBreak` / `maxDuration` 不能从工具参数改**：schema 里没有这两个字段（`src/tools/narrate.mjs:29-61`），只能改代码（返回里的 `note` 也是这么说的，`src/tools/narrate-actions.mjs:144`）。传 `{gapBreak: Infinity, maxDuration: Infinity}` 可「只按句末标点断句」，但那是**核心函数**的用法（`src/core/srt.mjs:129-131`），工具层够不着。
  - **折行**：`text` 超过 `maxChars` 才折，折成**最多两行**；以中点为起点向两侧找 `，,、 `（含半角空格）分隔符，在**该字符之后**断行，找不到就在中点硬切（:87-101）。**与 Python 版的唯一有意差异**：保留断点处的标点，保证 `折行结果去掉 \n == 原文`（:78-82）。
  - **去重**：只比较**相邻两条的文本是否完全相等**，相等就丢掉后一条（保留先出现的时间），然后从 1 重新编号（:112-119）。
  - 落盘：`dirname(wordsPath)/voiceover.cues.json`，内容 `{ audio: null, cues }`（`src/tools/narrate-actions.mjs:136-137`），并把 `lastCuesPath` 指向它。
- **输出**：`{ cuesPath, cueCount, cues, note }`（:140-145）；每条 cue 是 `{ index, start, end, text }`，`text` 里可能含一个 `\n`，`start/end` 保留原始浮点（`src/core/srt.mjs:152-158`）。
- **代价**：零成本、离线、毫秒级。无网络、无宿主服务。
- **失败与陷阱**：
  - `video_narrate to_cues: 没有可用的逐词时间戳。请先调用 video_narrate {action:"synthesize"}，或显式传 "wordsPath"。`（:43-45）
  - `video_narrate to_cues: 找不到时间戳文件 <path>`（:47）；`... 里没有词。`（:134）。
  - 时间戳文件必须是**合法 JSON**：`JSON.parse` 不捕获异常，坏文件会抛原始 `SyntaxError`，不是友好文案（:48）。
  - 输出文件名固定：同一目录下换一份词表重跑会覆盖上一份 cues。
- **典型用法**：
  ```json
  { "action": "to_cues", "wordsPath": "narration/voiceover.words.json", "maxChars": 16 }
  ```
- **相邻动作**：接 `srt_write`（序列化）或 `layout`（算烧录样式）；`layout` 会读同一个 `lastCuesPath`。

### action: srt_write

- **用途**：字幕条 JSON → `.srt` 文本文件。
- **参数**：`action`、`cuesPath`、`srtPath`、`cwd`。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `srt_write` |
| cuesPath | string | 否 | 上一次 `to_cues`/`layout` 的输出 | 字幕条 JSON；数组或 `{cues}` 都接受（:64） |
| srtPath | string | 否 | `dirname(cuesPath)/voiceover.srt` | 目标 `.srt`；相对 `cwd` 解析 |
| cwd | string | 否 | 见总表 | 路径基准 |

- **行为细节**：`formatSrt` 逐条输出 `序号\n起 --> 止\n文本\n`，块间空行，因此**以换行结尾**；序号直接用 `cue.index`，**不重排**（`src/core/srt.mjs:262-268`）。时间戳格式 `HH:MM:SS,mmm`，毫秒取整复刻 Python 的**银行家舍入**（正好 .5 取偶），因为 Edge 时间戳大量精确落在 x.5ms（:209-227、240-251）；负数/NaN/Infinity 一律按 0（:241）。写文件不含 BOM（:254）。
- **输出**：`{ srt, cueCount, source }`（:161）。
- **代价**：零成本、离线。
- **失败与陷阱**：`没有可用的字幕条。请先调用 video_narrate {action:"to_cues"}，或显式传 "cuesPath"。`（:57-60）、`找不到字幕文件 <path>`（:62）、cues JSON 坏 → 抛 `SyntaxError`（:63）。
- **典型用法**：
  ```json
  { "action": "srt_write", "cuesPath": "narration/voiceover.cues.json", "srtPath": "narration/voiceover.srt" }
  ```
- **相邻动作**：把产物路径填进 `plan.json` 的 `subtitles.source`（`src/core/plan.mjs:344,504-505`；烧录/软挂由 `src/core/finalize.mjs:32-44,168-171,215` 消费，且**只认 `.srt`/`.ass`**）。

### action: srt_read

- **用途**：外部 `.srt` → 字幕条数组（用于改字幕、算样式、复用别人的时间轴）。
- **参数**：`action`、`srtPath`（必需）、`cwd`。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `srt_read` |
| srtPath | string | **是** | — | 源 `.srt`；相对 `cwd` 解析（:171-175） |
| cwd | string | 否 | 见总表 | 路径基准 |

- **行为细节**：宽容解析（`src/core/srt.mjs:288-325`）——忽略 BOM、`\r\n`/`\r` 都当换行、**序号缺失或乱序都行**（序号不参与解析），时间行的毫秒分隔符 `,` 与 `.` 都接受（:271），毫秒不足 3 位右补零（`5` = 500 ms，:274、282-286）。块里找不到时间行、或时间行后没有文本 → **跳过该块不报错**；整体不可解析返回空数组（:301）。结果从 1 重新编号。
- **输出**：`{ srt, cueCount, cues }`（:177）。
- **代价**：零成本、离线。
- **失败与陷阱**：`需要 "srtPath"。`（:172）、`找不到字幕文件 <path>`（:175）。**空结果与「文件里真没字幕」无法区分**——返回 `cueCount: 0` 而不是报错（:301）。分块用 `/\n\s*\n/`（:306）且块内空行被过滤（:307），所以**一条字幕正文里的空行会把该条截断，空行之后的文字整块没有时间行而被丢弃**（:308-315）。
- **典型用法**：
  ```json
  { "action": "srt_read", "srtPath": "inputs/subtitles.srt" }
  ```
- **相邻动作**：读进来后交给 `layout` 算样式（它会读 `lastCuesPath`——注意 `srt_read` **不会**更新 `lastCuesPath`，只有 `to_cues`/`layout` 会，:138、:213）。

### action: layout

- **用途**：给定画布尺寸，算出一组可直接粘进 `plan.json` 的 `subtitles` 样式数值（字号、下边距、颜色、描边、每行字数）。**它不渲染任何东西**。
- **参数**：`action`、`cuesPath`、`maxChars`、`scale`、`canvasWidth`、`canvasHeight`、`cwd`。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `layout` |
| cuesPath | string | 否 | 上一次 `to_cues`/`layout` 的输出 | 只用于统计 `cueCount` 与（`scale` 生效时）缩放；**读不到也不报错**（:205-220 的 `try/catch` 全吞） |
| maxChars | integer | 否 | 18 | 直接写进 `max_chars_per_line`（:200） |
| scale | number | 否 | 1 | >0 且 ≠1 时把所有 cue 时间乘该系数，另存 `voiceover.scaled.cues.json` 并把 `lastCuesPath` 指过去（:209-216） |
| canvasWidth | integer | 否 | 1080 | 画布宽；`字号 = round(44 × 宽/1080)`（:191、195） |
| canvasHeight | integer | 否 | 1920 | 画布高；`margin_v = round(高 × 0.104)`（:196） |
| cwd | string | 否 | 见总表 | 路径基准 |

- **行为细节**：
  - 固定样式：`enabled: true`、`burn: true`、`primary_color: '#FFFFFF'`、`outline_color: '#000000'`、`outline: 3`（:192-201）。**没有** `bold`、`source`。
  - 安全区/尺度语义：字号与下边距都是**按 1080 宽画布标定**的（:189-191）；1920×1080 得到 `font_size: 78`、`margin_v: 112`（与 `tests/filter.test.mjs:200-212` 的断言一致）；1080×1920 得到 `font_size: 44`、`margin_v: 200`，与 `plan.json` 默认值完全一致（`src/core/plan.mjs:346-347`）。
  - 数值合法性落在 plan.json 的取值域内：`font_size` 8–200、`margin_v` 0–2000、`outline` 0–20、`max_chars_per_line` 4–80（`src/core/plan.mjs:346-355`）。
  - **`scale` 的产物是 cues JSON，不是 SRT**；返回里的 `note` 却说「请把该路径写进 plan.json 的 subtitles.source」（:216），而 `subtitles.source` 的消费方只按 `.ass` 或「其它一律当 SRT」处理（`src/core/finalize.mjs:36`）——直接把 cues JSON 填进去会被 libass 当 SRT 解析。**可靠做法**：`to_cues` → （可选 `layout {scale}`）→ `srt_write`（它会优先读 `lastCuesPath`，即缩放后的那份）产出 `.srt`，再把 `.srt` 填进 `subtitles.source`。这是代码内部不一致，**未证实**是有意为之。
- **输出**：`{ subtitles, cueCount, source, note }`，`scale` 生效时额外返回 `scaledCuesPath`（:216、223-228）。`cueCount`/`source` 在无 cues 时为 `null`。
- **代价**：零成本、离线、纯计算。无网络、无宿主服务。
- **失败与陷阱**：
  - 无 cues 时**不报错**，只返回 `cueCount: null`、`source: null` ——调用方必须自己判断，否则会拿着样式却忘了 `subtitles.source`（:218-220、:227 的 note 就是在提醒）。
  - `scale` 只改字幕时间，**不改音频**；它是为「画面被重新剪辑/变速」准备的（:191-192 注释、`src/core/srt.mjs:191-193`）。`scale` 传 `1` 或 `0`/负数时不缩放、也不写文件（:209）。
  - `canvasWidth`/`canvasHeight` 传非数值（如字符串）会被 `Number.isFinite` 挡掉并回落到 1080/1920（:187-188）。
- **典型用法**：
  ```json
  { "action": "layout", "cuesPath": "narration/voiceover.cues.json", "canvasWidth": 1080, "canvasHeight": 1920, "maxChars": 16 }
  ```
- **相邻动作**：`subtitles` 直接进 `plan.json` 的 `subtitles` 块；若用了 `scale`，紧接一次 `srt_write` 把缩放后的 cues 序列化成 SRT，再填 `subtitles.source`。

### action: transcribe

- **用途**：读出现有视频/音频里说了什么（整句级文本 + 每段的时间范围与推理耗时）。
- **参数**：`action`、`audioPath`（必需）、`language`、`maxAudioSeconds`、`cwd`。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `transcribe` |
| audioPath | string | **是** | — | 音视频文件；相对 `cwd` 解析；不存在报错（:238-242） |
| language | string enum | 否 | `auto` | `auto`/`zh`/`en`/`yue`/`ja`/`ko`；`auto` → 不传语言（:273）。命名语言能提高准确率（schema 描述，`src/tools/narrate.mjs:46`） |
| maxAudioSeconds | integer | 否 | 131 | 单次请求秒数预算；换算 `maxAudioBytes = max(1024, floor(秒 × 32000))`（:252-253） |
| cwd | string | 否 | 见总表 | 路径基准 |

- **行为细节**：
  - **识别不在本插件里**：它在宿主的 `speechToText` 服务后面（本地 SenseVoice Provider，`src/core/transcribe.mjs:1-6`），本插件只是适配器。服务通过 `locate()` **每次调用现取**（`src/tools/shared.mjs:94-104`、`src/tools/index.mjs:59`），所以启停语音 bundle 不需要重挂插件。
  - **离线条件**：模型就绪后完全离线（本模块不发任何网络请求；工具描述也这么写，`src/tools/narrate.mjs:26`）。首次使用需先下载模型——README:103 说约 239 MB（INT8）、缓存到 `~/.dsh/speech-to-text/sensevoice`、SHA-256 校验；**这一条未在本次读到的代码里证实**（属文档陈述）。代码只会在诊断时提示 `本地识别模型尚未就绪，首次使用会先下载模型`（:262-264）。
  - **必须转成规范 WAV**：`ffmpeg -i <src> -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav`（:117-124，超时 30 分钟），然后**手工修 WAV 头**（走 chunk 链找到 `data`，重写 RIFF 长度与 data 长度）——因为 ffmpeg 直接写文件路径时会把 data size 留在占位值，宿主的校验会因此认为音频只有约 1 毫秒（:47-102、:104-134）。
  - **4 MB / 单次**：默认真实上限来自 `DEFAULT_MAX_AUDIO_BYTES = 4 MiB`，16 kHz 单声道 PCM16 = 32000 B/s，故约 131 秒（`src/core/transcribe.mjs:24-31`、`src/tools/narrate-actions.mjs:22-23`）。
  - **切分策略**：文件不超预算 → 整段一次识别（:266-267）；超了就先用 `silencedetect=noise=-35dB:d=0.35` 找静音（:34、:37、:274-284，**只读 stderr**，且「静音到没有语音」时 ffmpeg 非零退出属正常，异常路径也照样解析 stderr，:285-287），再按「每个切点尽量靠后、且落在上限前 25 秒窗口内」选切点（:175-199），找不到就按字节上限硬切并**计入 `forcedCuts`**（:192-196）。每段用 `-ss/-t` **重新编码**（不能 stream copy：任意偏移复制的头会与自身数据长度矛盾，识别器会读成零点几秒，:201-227）。
  - 每段都调 `service.resolve({audio, language?, providerId?})` 再 `service.transcribe(spec, signal)`（:309-318）。**`providerId` 是核心参数但工具 schema 没暴露**（`src/tools/narrate.mjs:29-61` 没有该字段），即无法在工具层指定识别器。
  - 临时目录 `os.tmpdir()/vf-asr-*`，结束时整目录删除（:253、:343-345）。
- **输出**：`{ source, text, parts, pieceCount, audioSeconds, inferenceSeconds, forcedCuts, wavBytes, note?, provider }`（:329-342、`src/tools/narrate-actions.mjs:283`）。
  - `text`：各段文本用 `\n` 连接再 `trim()`（:331）——**没有逐词时间戳，也没有句级时间轴**。
  - `parts[]`：`{ text, from, to, audioSeconds, inferenceSeconds }`，`from`/`to` 是这一段在原始音频里的秒数范围（:320-326）。
  - `provider`：`{ id, name, location }`，来自 `service.snapshot()` 的当前选择；取不到时为 `null`（诊断用，失败不影响转录，:257-267、:283）。
  - `note`：仅当有硬切时出现，说明「N 处切分没有找到静音点，可能截断一个词」（:338-341）。
- **代价**：**需要宿主服务**（没有就不可用）；本地算力，无 API 费用；成本 ≈ ffmpeg 转码（一次全片 + 每段一次）+ 推理时间，`inferenceSeconds` 会如实上报（:305、:319）。首次装模型有一次性下载（README:103）。
- **失败与陷阱**：
  - `video_narrate transcribe: 需要 "audioPath"（要转录的音视频文件）。`（:239）
  - `video_narrate transcribe: 文件不存在 <path>`（:242）
  - `宿主没有提供 speechToText 服务，语音转文字不可用。请在「设置 → 插件管理」里启用语音输入 bundle（@deepseek-ai/dsh-experimental-voice-input-bundle）并重启 DSH。`（:246-249）
  - `转录失败：音频转换失败（...）` / `转录失败：音频是空的：...`（:285、`src/core/transcribe.mjs:126-128,258-260`）
  - **不要指望它给字幕时间轴**：粒度是整段（README:108）。
  - `maxAudioSeconds` 调很大时，`maxAudioBytes` 随之变大，但宿主本身有 4 MB 上限——超过上限的请求能不能被宿主接受**未证实**（代码只负责按你给的字节预算切分）。
- **典型用法**：
  ```json
  { "action": "transcribe", "audioPath": "inputs/rough-cut.mp4", "language": "zh" }
  ```
- **相邻动作**：`text` 可作为新一轮 `synthesize` 的文案来源；`parts[].from/to` 可用于按说话段对齐画面（不是字幕）。

### 与 `docs/豆包语音播客-API契约.md` 的关系（印证/推翻）

- **不构成印证**：该文档描述的是火山**播客 TTS** WebSocket 协议（`wss://openspeech.bytedance.com/api/v3/sami/podcasttts`，文档第 225 行；`X-Api-Key`/`X-Api-Resource-Id: volc.service_type.10050`，第 236–244 行；`action: 0/3/4`、`nlp_texts[].speaker`，第 318–352、546–565 行；`audio_config`，第 425–442 行；`aigc_watermark`/`aigc_metadata`，第 393–423 行；结果 `audio_url` 有效期 1 小时，第 366–367、713–714 行；错误码 45000000/40000010/40000022/55000000/50302102，第 1394–1425 行）。`video_narrate` 走的是 **Edge 朗读**（`src/core/tts.mjs:25`），**无需 Key、无 speaker、无音频水印/元数据、无并发限额概念**，音频是 24 kHz 单声道 MP3（:40）。全仓检索 `podcast|sami|openspeech` 只命中该文档本身，**没有任何代码引用它**。
- **可以引出的结论**：① 本插件的配音能力**不含双人对谈**；② 若将来要做多人播客配音，需要换到该文档的协议（有 Key、有 speaker、有 `aigc_metadata` 隐式标识能力），而不是扩展现有 `synthesize`；③ 该文档的「结果 URL 1 小时过期」与方舟视频/图像结果的「24 小时过期」（`src/core/ark.mjs:8`）是两套不同的有效期，别混用。

---

## 工具 video_gen

**一句话定位**：调用字节跳动火山方舟（Volcengine Ark）的 Seedance 视频与 Seedream 图像接口，先查账号可见模型，再生成并把结果**下载到本地**。

**何时用**：缺镜头要补拍（`generate`）、要封面/缩略图/单张配图（`image`）、先确认这个账号能用哪个模型（`models` / `image_models`）。

**何时不该用**：
- **它是本插件唯一不满足「同输入同输出」的工具**（`src/tools/gen.mjs:8-11,26`）。要可复现的成片，不要用它；它只负责产出素材，取舍与编排归 DSH。
- 没有配置 `ARK_API_KEY`（或配置指向的环境变量）时**四个 action 全部不可用**，错误在第一个 action 之前就抛出（`src/tools/gen-actions.mjs:34-43`）。本地剪辑/配音/字幕不受影响。
- 不要用它做「免费试参数」：图像端点没有空跑这回事（`docs/插件设计规格.md:900-903`）。
- 不要把它当成「返回 URL 的 API」：结果 URL 是 **24 小时过期**的 TOS 预签名链接（`src/core/ark.mjs:8-9,270-272`），本工具一律先落盘。

### action 总览与全量 schema 字段表

`action` 必填、枚举四个值（`src/tools/gen.mjs:33`）。「含义」列用【动作名】标出该字段**只对哪个 action / 哪个模型-模式组合有效**；`models` 与 `image_models` 除 `action`/`cwd` 外**不读任何字段**。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | `models` / `generate` / `image_models` / `image`（`src/tools/gen.mjs:33`） |
| prompt | string | 否* | — | 【generate】必需（`gen-actions:191-193`）；【image】在没有 `imagePrompt` 时作为图像提示词（:125-128） |
| imagePrompt | string | 否 | — | 【image】非空时**覆盖 `prompt`**（:125）。存在理由：一份 plan 里同时带视频 prompt 和图像 prompt 而不撞名（:123-124） |
| imageSize | string | 否 | 交给服务端 | 【image】`'1k'`/`'2K'` 这类预设或 `'WIDTHxHEIGHT'`。本地先校验（`src/core/ark.mjs:438-440,511-537`）：形态必须匹配 `^\d+x\d+$` 或 `^[0-9]+k$`（大小写不敏感），且 `WxH` 面积必须落在 921600–4624220 像素（:57、:60） |
| imageCount | integer | 否 | — | 【image】保留字段。**只能为 1**：传 `1` 被忽略，传其它值报 `"imageCount" 只能是 1`（`gen-actions:129-133`） |
| mode | string enum | 否 | 推断 | 【generate】`text-to-video` / `image-to-video` / `first-last-frame`。不传时按 `lastFrame` → `first-last-frame`、`reference` → `image-to-video`、否则 `text-to-video` 推断（`gen-actions:195`；核心同样会推断并校验，`ark:757-770`） |
| reference | string | 条件必需 | — | 【generate】首帧图片。`mode` 非 `text-to-video` 时必需（`gen-actions:196-198`）。schema 说「本地路径或公网 URL」（`gen.mjs:51`）——**工具层实际只支持本地路径**，见下文陷阱 |
| lastFrame | string | 条件必需 | — | 【generate】末帧图片，`mode: "first-last-frame"` 必需（`gen-actions:199-201`） |
| duration | integer | 否 | 由模型/服务端决定 | 【generate】**取值域按模型不同**，代码不代填、不本地校验（`ark:280,1038-1039`）。实测 Seedance 2.0 系 t2v 为 4–15（`gen.mjs:53`、README:449、`docs/插件设计规格.md:798`） |
| resolution | string enum | 否 | 由模型/服务端决定 | 【generate】`480p`/`720p`/`1080p`/`4k`（`gen.mjs:54`） |
| ratio | string enum | 否 | 由模型/服务端决定 | 【generate】`16:9`/`9:16`/`1:1`/`4:3`/`3:4`/`21:9`/`adaptive`；`adaptive` 跟随参考图（`gen.mjs:55-59`） |
| model | string | 否 | 配置 `ark.defaultModel` → 无 | 【generate】方舟视频模型 id。**两者都缺就报 `缺少 spec.model`**（`ark:729-737`）。不要硬编码，先 `models`（`gen.mjs:60`） |
| imageModel | string | 否 | 配置 `ark.imageModel` → `doubao-seedream-5-0-flash-260915` | 【image】图像模型 id（`gen-actions:141`；默认值来自 `ark:54`，在售且比 pro 便宜，:53） |
| seed | integer | 否 | 服务端默认 | 【generate】**和**【image】都转发（`gen-actions:146,218`），尽管 schema 只写了 `generate`（`gen.mjs:65`）。`-1` = 随机；固定种子只是「近似可复现」（`gen.mjs:65,26`）。核心只做 `typeof number && isFinite` 过滤（`ark:442`、`OPTIONAL_FIELDS`，:82） |
| generateAudio | boolean | 否 | 服务端默认 | 【generate】请求同步音频（`gen.mjs:66` → `generate_audio`，`ark:85`）。是否真的支持由模型决定 |
| draft | boolean | 否 | 服务端默认 | 【generate】要更便宜的低分辨率草稿（`gen.mjs:67` → `draft`，`ark:86`）。不支持该档的模型会直接报参数错 |
| serviceTier | string | 否 | 不传 | 【generate】如 `"flex"`（离线队列、更便宜更慢）。**Seedance 2.0 全系拒绝**（`gen.mjs:68-72`、`ark:289,1030-1031`）。只在 `models` 表明支持时才传 |
| returnLastFrame | boolean | 否 | 服务端默认 | 【generate】额外返回末帧 URL 以便续写（`gen.mjs:73` → `return_last_frame`，`ark:87`）。**只返回 URL，不落盘**（`ark:361-362,382`） |
| cameraFixed | boolean | 否 | 服务端默认 | 【generate】固定机位（`gen.mjs:74` → `camera_fixed`，`ark:84`） |
| watermark | boolean | 否 | **服务端默认（代码不代填）** | 【generate】与【image】都转发（`gen-actions:146,219`）。schema 写「默认 true」（`gen.mjs:75`），但代码只在**显式传布尔值**时才放进请求体（`ark:441,742-747`）；只有显式 `false` 会触发「请自行添加 AI 生成内容标识」的返回 note（`gen-actions:173-175,252-254`） |
| outDir | string | 否 | `<cwd>/generated` | 【generate】/【image】落盘目录，递归创建（`gen-actions:135-139,203-207`） |
| sceneId | string | 否 | — | 【generate】输出文件名 `<sceneId>.mp4`（`gen-actions:237`；缺省用 jobId，`ark:958-965`）。【image】输出 `<sceneId>.png`，**扩展名可能被服务端返回格式改写**（`gen-actions:151`；`ark:551-560`） |
| pollIntervalSeconds | integer | 否 | 参数 → 配置 `ark.pollIntervalSeconds` = 15 | 【generate】轮询间隔秒（`gen-actions:228`；`ark:305`）。核心做 `numberOr`：非有限或负数回落 15，**`0` 被尊重**（`ark:989-993`） |
| maxWaitSeconds | integer | 否 | 参数 → 配置 `ark.maxWaitSeconds` = 900 | 【generate】最长等待秒（`gen-actions:229`；`ark:306`）。**`0` 会在提交后立刻超时**，见陷阱 |
| cwd | string | 否 | 见 narrate 总表 | 路径基准（`src/tools/shared.mjs:28-32`） |

> *`generate` 与 `image` 都**先取 API Key 再校验 prompt**（`gen-actions:122,190`），所以没配 Key 时看到的是环境变量报错，不是「需要 prompt」。

### action: models

- **用途**：列出本账号可见的 Seedance 视频模型及其在售状态。**不花钱**（只读 `/models`）。
- **参数**：`action`、`cwd`（其余字段不读）。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `models` |
| cwd | string | 否 | 见 narrate 总表 | 路径基准（本 action 不用路径） |

- **行为细节**：`GET {baseUrl}/models?page_num=N&page_size=100`，最多翻 50 页，按 `id` 去重；**不满一页即停**，同一页没新增也停（防止服务端忽略分页导致死循环）（`src/core/ark.mjs:30,33,169-183`）。默认只用 `id.includes('seedance')` 过滤（:166,186）。状态分档 `availabilityOf`（:910-917）：缺省/空 → `live`，`Retiring` → `retiring`，`Shutdown` → `shutdown`，**其它未预期取值也归 `shutdown`**（`status` 原样保留）。鉴权用 `Authorization: Bearer <key>`（:604），baseUrl 空则回落北京区默认端点（:24,654-657）。
- **输出**：`{ total, scanned, live, models, recommended, note }`（`src/tools/gen-actions.mjs:62-71`）。
  - `total` = **过滤后**条数；`scanned` = 账号可见模型总数（未过滤）（`ark:194`）。
  - `models[]` = `{ id, name, status, availability }`。
  - `recommended` = 配置 `ark.defaultModel`，否则第一个 `live` 的 id，否则 `null`（:67）。
  - `note` 明确要求：`live` 才是在售，未开通会返回 `ModelNotOpen`，需去控制台激活（:68-70）。
- **代价**：一次或数次 HTTP 往返，**无生成费用**。需要 API Key。
- **失败与陷阱**：`video_gen: 环境变量 ARK_API_KEY 没有设置，云端生成不可用。...`（:37-40，变量名以配置为准）；`读取模型列表失败：方舟鉴权失败（HTTP 401）：...` / `...找不到模型...` / `...接口报错（code=...）`（:73、`ark:686-721`）。**`live` 只表示「在售」，不表示「本账号已开通」**——真正的拦截发生在 `generate`（`ModelNotOpen`，`ark:694-700`）。
- **典型用法**：
  ```json
  { "action": "models" }
  ```
- **相邻动作**：把选中的 id 传给 `generate` 的 `model`；把它写进插件配置 `ark.defaultModel` 可省掉每次传参（`index.mjs:92`）。

### action: image_models

- **用途**：列出本账号可见的 Seedream 图像模型、在售状态，以及图像面积的本地硬限制。**不花钱**。
- **参数**：`action`、`cwd`。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `image_models` |
| cwd | string | 否 | 见 narrate 总表 | 路径基准（本 action 不用路径） |

- **行为细节**：与 `models` 同一条目录，只是过滤子串换成 `'seedream'`（`gen-actions:88`）。`recommended` 这里是 `配置 ark.imageModel ?? DEFAULT_IMAGE_MODEL`（**不会**取第一个 live，:95）。
- **输出**：`{ total, scanned, live, models, recommended, limits, note }`（:90-104）。`limits = { minPixels: 921600, maxPixels: 4624220, note }`（:96-100）；`note` 提醒 `seededit` 与早期 seedream 多为 `Shutdown`（:101-103）。
- **代价**：同 `models`，无生成费用；需要 Key。
- **失败与陷阱**：`读取图像模型列表失败：...`（:106）。`recommended` 只是「默认会用哪个」，不代表在售——仍要以 `live` 为准。
- **典型用法**：
  ```json
  { "action": "image_models" }
  ```
- **相邻动作**：选出的 id 传给 `image` 的 `imageModel`。

### action: image

- **用途**：文生图一张，同步返回，落盘为本地图片文件。适合封面、缩略图、缺一张配图。
- **参数**：`action`、`prompt` / `imagePrompt`、`imageSize`、`imageCount`、`imageModel`、`seed`、`watermark`、`outDir`、`sceneId`、`cwd`。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `image` |
| prompt | string | 二选一 | — | 画面描述（`imagePrompt` 为空时使用） |
| imagePrompt | string | 二选一 | — | 非空时优先于 `prompt` |
| imageSize | string | 否 | 服务端默认 | 预设或 `WxH`；本地先校验形态与面积 |
| imageCount | integer | 否 | — | 只允许 `1`（或省略） |
| imageModel | string | 否 | `doubao-seedream-5-0-flash-260915` | 覆盖默认图像模型 |
| seed | integer | 否 | 服务端默认 | 转发给服务端（`-1` 随机） |
| watermark | boolean | 否 | 服务端默认 | 显式 `false` 时返回文案会提醒自行加标识 |
| outDir | string | 否 | `<cwd>/generated` | 落盘目录 |
| sceneId | string | 否 | — | 文件名 `<sceneId>.png`（扩展名可能被改写） |
| cwd | string | 否 | 见 narrate 总表 | 路径基准 |

- **行为细节**：
  - **同步**：`POST {baseUrl}/images/generations`，一次请求直接拿结果，**没有提交/轮询两段**（`src/core/ark.mjs:398-421`）。实测 2K 图约 12 秒（`docs/插件设计规格.md:868`）；工具描述写「约十五秒」（`gen.mjs:26`）。
  - **请求体只放显式给出的字段**：`{ model, prompt }` + `size`（校验后）/ `watermark`（仅布尔）/ `seed`（仅有限数）/ `response_format`（本工具从不传）（`ark:435-445`）。
  - **`size` 本地先拒**：形态不收 → `size 必须是 'WIDTHxHEIGHT'（如 '1024x1024'）或预设字符串（如 '1k'、'2K'）`；面积 < 921600 → 「太小」；> 4624220 → 「太大」（`ark:511-537`）。注意 `'4k'` **能通过本地形态校验**但服务端拒绝（`docs/插件设计规格.md:887`）。
  - **模型白名单只是提醒**：`model` 不在 `IMAGE_MODELS` 列表时打一条 `warning` 进度（含建议先 `listModels({filter:'seedream'})`），**不阻断**（`ark:426-433`）。
  - **落盘**：有 `url` 就立刻下载；服务端若走内联 `b64_json` 就直接写字节；两者皆无报 `图像响应里既没有 url 也没有 b64_json`（`ark:461-487`）。
  - **文件名**：`<sceneId>.png` 或 `seedream-YYYYMMDDHHMMSS.<ext>`；扩展名一律以服务端 `output_format` 为准（jpeg → `.jpg`，不认识就原样用），**会丢弃与内容不符的旧扩展名**而不是追加（`ark:551-573,581-584`）。
  - **尺寸以实测为准**：落盘后再用 ffprobe 探测真实宽高与字节数（`gen-actions:161-164`）。
- **输出**：`{ localPath, url, size, outputFormat, usage, model, resolvedParams, width, height, bytes, planFragment, note? }`（`gen-actions:165-176`，核心返回见 `ark:490-498`）。
  - `url` 是 24 小时过期的预签名链接，**只是信息**；`localPath` 才是交付物。
  - `resolvedParams` 是**实际发出去的请求体**，可用于核对哪些参数真的生效了。
  - `planFragment = { kind: 'image', source: localPath }`，可直接作为 plan.json 某镜头的 `source`。
  - `width`/`height` 来自 ffprobe，`bytes` 是文件大小（`src/core/probe.mjs` 的 `probe` 返回 `sizeBytes`）。
- **代价**：**要钱**（每次调用都会真的出图并计费——`docs/插件设计规格.md:900-903` 的成本教训）；单次约十几秒；不发轮询、无长等待。**代码里没有任何价格常量**，成本只能靠返回的 `usage`（token 数）与 `resolvedParams`（模型/尺寸）事后核算（`ark:495`；实测 2K 图 `total_tokens: 16224`，`docs/插件设计规格.md:875`；价格一项该文档标为「未查」，:825）。
- **失败与陷阱**：
  - `video_gen image: 需要 "prompt"（或 "imagePrompt"）。`（:127）；`当前模型每次请求只返回一张图，"imageCount" 只能是 1。要更多请多次调用。`（:130-132）。
  - `图像生成失败：size '512x512' 太小：图像面积至少 921600 像素（实测下限，约 960x960）。` / `... 太大 ...` / `... 必须是 'WIDTHxHEIGHT' ...`（`ark:517-535`）
  - `图像生成失败：模型 ... 存在于方舟但本账号未开通，请到方舟控制台激活该模型后重试。`（`ModelNotOpen`，`ark:694-700`）；`... 方舟找不到模型 ...（模型不存在，或本账号/本区域不可见）`（`InvalidEndpointOrModel.NotFound`，:702-708）——**两者都是 HTTP 404，含义完全不同**，不要只看状态码。
  - **`sceneId` 给的扩展名不一定被保留**：传 `sceneId: "cover"` 得到 `cover.png`，但服务端返回 jpeg 时实际落地 `cover.jpg`（`ark:551-560`，README:479）。下游若按扩展名分类素材，必须用返回的 `localPath`，不要自己拼。
  - **图像端点没有「空跑参数」**：只要 `model` + `prompt` 齐备就可能出图计费（`docs/插件设计规格.md:900-903`）。
  - **未证实**：`response_format: 'b64_json'` 在本工具下走不到（工具层从不传该字段，`ark:443-445`），但核心代码为它准备了分支（:467-487）。
- **典型用法**：
  ```json
  { "action": "image", "prompt": "极简科技感封面，深蓝渐变，中央一个发光的播放键", "imageSize": "2K", "sceneId": "cover", "outDir": "generated" }
  ```
- **相邻动作**：`planFragment` 进 plan.json 的镜头 `source`；或把 `localPath` 作为 `generate` 的 `reference`（图生视频）。

### action: generate

- **用途**：提交一次视频生成任务，轮询到完成，把结果**下载到本地**，返回本地路径与最终任务快照。
- **参数**：`action`、`prompt`、`mode`、`reference`、`lastFrame`、`duration`、`resolution`、`ratio`、`model`、`seed`、`generateAudio`、`draft`、`serviceTier`、`returnLastFrame`、`cameraFixed`、`watermark`、`outDir`、`sceneId`、`pollIntervalSeconds`、`maxWaitSeconds`、`cwd`。

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | 固定 `generate` |
| prompt | string | **是** | — | 提示词；空则 `需要 "prompt"`（:191-193） |
| mode | string enum | 否 | 按 `lastFrame`/`reference` 推断 | 三选一；显式值必须是三者之一，否则报 `未知的 spec.mode`（`ark:757-770`） |
| reference | string | 条件必需 | — | 首帧图；本地路径（PNG/JPEG/WebP/BMP/GIF/TIFF）（`ark:63-72,833-851`） |
| lastFrame | string | 条件必需 | — | 末帧图，仅 `first-last-frame` |
| duration / resolution / ratio | integer/string/string | 否 | 模型默认 | 服务端判定取值域；本地不代填不越界校验（`ark:1038-1039`） |
| model | string | 否 | 配置 `ark.defaultModel` | 两者都缺 → `缺少 spec.model：必须显式指定方舟模型 id（例如 doubao-seedance-2-0-260128）...`（`ark:729-737`） |
| seed | integer | 否 | 服务端默认 | `-1` 随机；固定种子「近似可复现」 |
| generateAudio / draft / returnLastFrame / cameraFixed | boolean | 否 | 服务端默认 | 分别映射 `generate_audio` / `draft` / `return_last_frame` / `camera_fixed`（`ark:84-87`） |
| serviceTier | string | 否 | **不传** | 2.0 全系拒绝，传了直接报错（`ark:289,744`） |
| watermark | boolean | 否 | 服务端默认 | 显式 `false` → 返回文案提醒自行加 AI 标识 |
| outDir | string | 否 | `<cwd>/generated` | 落盘目录 |
| sceneId | string | 否 | — | 文件名 `<sceneId>.mp4`；缺省 `<jobId>.mp4` |
| pollIntervalSeconds | integer | 否 | 15 | 轮询间隔；`0` 会被尊重（变成无间隔连轮） |
| maxWaitSeconds | integer | 否 | 900 | 最长等待；**`0` = 提交后立刻超时** |
| cwd | string | 否 | 见 narrate 总表 | 路径基准 |

- **行为细节**：
  - **调用链**：`gen-actions.generate` → `core/ark.generate` = `submit` → 循环 `poll` → 成功后**立刻下载**（`src/core/ark.mjs:303-391`）。之所以必须一条龙：结果 URL 是 `X-Tos-Expires=86400`（24 小时）的预签名链接，把 URL 交出去等于把成片放在会消失的地方（`ark:8-9,267-272`，`docs/插件设计规格.md:795`）。
  - **请求体只含显式字段**：`{ model, content: [...] }` + 白名单里的可选字段（`duration/resolution/ratio/seed/watermark/camera_fixed/generate_audio/draft/return_last_frame/service_tier`），**未显式给出的绝不补默认值**（`ark:742-747,78-89`）。
  - **`content` 组装**：`text` 必有；`image-to-video` 追加 `{type:'image_url', image_url:{url}, role:'first_frame'}`；`first-last-frame` 再追加 `role:'last_frame'`（`ark:778-825`）。本地图片被读成 base64 data URL（`ark:833-851`）；`http(s)://` 与 `data:` 原样传递（核心层，:835）。
  - **模式互斥校验**（核心层，友好且成对）：`text-to-video` 带图 → 报错让改模式；`image-to-video` 带 `lastFrame` → 报错让改成 `first-last-frame`；`first-last-frame` 缺 `lastFrame` → 报错（`ark:784-822`）。
  - **轮询**：`pollIntervalSeconds` 默认 15、`maxWaitSeconds` 默认 900（`ark:305-306`）。每轮先查期限、再 `poll`、归一化状态、报进度；`succeeded` 跳出，`failed`/`expired`/`cancelled` 立刻抛错，**未知状态继续轮**；睡眠取 `min(间隔, 剩余时间)`（`ark:329-351`）。状态别名表把 `queued/pending/created/submitted/waiting/in_queue` 归 `pending`，`running/processing/generating/in_progress` 归 `running`，`success/completed/done` 归 `succeeded` 等（`ark:92-116`）。
  - **成功后的完整性检查**：`content.video_url` 为空 → `任务 <id> 已成功，但响应里没有 content.video_url，无法下载结果。`（`ark:353-360`）；下载到 0 字节文件 → `下载到的生成结果为空文件，已放弃写入。`（`ark:874`）；下载非 2xx → 报错并附「URL 24 小时过期，过期后只能重新生成」（`ark:866-871`）。
  - **文件名**：`sceneId` → `<sceneId>.mp4`，否则 `<jobId>.mp4`；无扩展名自动补 `.mp4`（`ark:958-965`）。
- **输出**：`{ localPath, jobId, state, videoUrl, lastFrameUrl, usage, seed, duration, resolution, ratio, pollCount, elapsedSeconds, note? }`（`ark:377-390` + `gen-actions:248-255`）。
  - `localPath` 是交付物；`videoUrl` 是 24 小时过期的链接（信息用途）。
  - `usage` 是服务端用量（估成本的唯一代码内依据）；`seed`/`duration`/`resolution`/`ratio` 是**服务端确认过的**实际值——固定 `seed` 后可用它核对是否真的按种子出片。
  - `pollCount`/`elapsedSeconds` 是等待画像（实测 4 秒片约 87 秒完成，README:453）。
  - `note`：结果已本地化 + 显式关水印时的标识义务提醒（`gen-actions:250-254`）。
- **代价**：**要钱**，且是四个 action 里最贵最长的一个；一次调用 = 一次生成 + 轮询（默认每 15 秒一次状态请求）+ 一次下载；耗时分钟级（`gen.mjs:26`）。代码内**没有价格常量**，成本只能事后从 `usage` 核算（`docs/插件设计规格.md:825`：本次 4s/480p 消耗 `40594` completion tokens，价格页未查）。省钱杠杆只有两个，且都依赖模型支持：`draft`（更便宜的草稿档，`gen.mjs:67`）与 `serviceTier: "flex"`（离线队列，`gen.mjs:71`；该文档称便宜 50% 但标为未实证，`docs/插件设计规格.md:855`）。
- **失败与陷阱**：
  - **公开 URL 当参考图会失败**：`gen-actions` 先用 `path.resolve(context.cwd, reference)` 处理（:213-214），`https://x/a.png` 会被解析成 `<cwd>\https:\x\a.png`，随后核心的 `imageToUrl` 走本地路径分支、`existsSync` 失败，报 `spec.reference 指向的本地图片不存在：...`（`ark:833-840`）。`data:` URL 同理。**schema 描述里的「公网 URL」在工具层不可用**（`gen.mjs:51` 与 `ark:278` 的说法只在核心层成立）。要联网图片请先下载到本地再传路径。
  - **`maxWaitSeconds: 0`（或很小的值）会在提交之后、第一次轮询之前就抛超时**（`ark:324-330`），钱已经花了；错误里带 `jobId` 与「任务可能仍在生成」的提示（`ark:926-932`）。
  - **超时后没有恢复入口**：提示说「可以稍后用 `poll('jobId', {apiKey})` 继续查询」，但 `poll` 只作为核心函数导出（`src/core/index.mjs:74`），**没有 `poll`/`retrieve` 这类 action**（`gen.mjs:33`），CLI 里也没有（`src/bin/vf.mjs` 只导入 `listModels` 与 `generateImage`）。从工具面看，超时 ≈ 重跑 ≈ 再花一次钱；`jobId` 只对写代码的调用方有意义。
  - **未知状态会一直轮**：`STATE_ALIASES` 没覆盖的 status 归一为 `unknown`（`ark:883-886`），循环只在四个终态或超时退出，因此一个没见过的状态会白等满 `maxWaitSeconds`。
  - **参数按「模型 + 模式」分别限定**：`serviceTier` 对 2.0 系报 `must be empty`（`ark:289,1030-1031`）；`duration` 在 2.0 系 t2v 是 4–15（1/2/3/16 都拒，README:449）。服务端会指明出错字段，错误被翻成 `方舟拒绝了请求参数（模型 X；参数支持按「模型 + 模式」分别限定）：<服务端原文>`（`ark:710-716`）。
  - **`returnLastFrame` 只给 URL 不给文件**（`ark:361-362,382`），而且「请求后是否真的返回 `content.last_frame_url`」在代码注释里标注为**未实证**（`ark:1034`、`docs/插件设计规格.md:823`）。想接着上一镜续写，得自己把那个 URL 下载下来再当 `reference`（因为上一条的 URL 直传会失败）。
  - **`duration` 只是请求值**：实测请求 4s 成片 4.096s（`docs/插件设计规格.md:798`），校验时不要用严格相等。
  - **落盘即覆盖**：同一个 `sceneId` 重跑会覆盖同名 mp4（`ark:958-965`）。
  - **未证实**：`queued` 状态是否真实存在（`ark:1032`）；图片上传要求（格式/体积/宽高比，`ark:1033-1035`）；`execution_expires_after`（本工具未暴露该字段）的合法区间。
- **典型用法**：
  ```json
  { "action": "generate", "prompt": "清晨的江南水乡，乌篷船缓缓划过石桥，薄雾，写实电影感", "duration": 5, "resolution": "720p", "ratio": "16:9", "seed": 12345, "sceneId": "s07", "outDir": "generated" }
  ```
- **相邻动作**：返回的 `localPath` 作为 plan.json 镜头的 `source`；`lastFrameUrl`（若真有）作为下一段的参考图原材料；`models` 先跑一遍再决定 `model`。

### gen 家族「非确定性」逐项说明（seed / draft / watermark / returnLastFrame / first-last-frame / 轮询 / 成本）

| 项 | 代码依据与确切语义 |
| --- | --- |
| 非确定性 | `src/tools/gen.mjs:8-11,26`：同 prompt 不同结果，只有固定 seed 才「近似可复现」；`src/tools/ark.mjs` 头部第 6–18 行明确本文件不做确定性保证。唯一的可复现抓手是 `seed` + 返回里的 `seed`/`resolvedParams` |
| seed | 【generate】`ark:82,218` → `seed`；【image】`ark:442`。`-1` = 随机。核心只做有限数过滤，不做范围校验（:442）。返回里的 `seed` 来自服务端快照（:260,384），可用来确认服务端是否采纳了你的种子 |
| draft | `gen.mjs:67` → `draft`（`ark:86`）。语义「更便宜的低分辨率草稿，若模型支持」；代码不校验模型是否支持，交给服务端报 `InvalidParameter`。是否真的更便宜**未证实**（代码无价格表） |
| watermark | 【generate】/【image】都转发（`gen-actions:146,219`）。schema 说默认 true（`gen.mjs:75`，`docs/插件设计规格.md:844` 也这么要求），但**代码不代填**：只有显式布尔才进请求体（`ark:441,744-746`）。唯一被强制执行的是**显式 `false` 时的提醒文案**（`gen-actions:173-175,252-254`）。因此「默认有水印」属**未证实**（取决于服务端默认） |
| returnLastFrame | `gen.mjs:73` → `return_last_frame`（`ark:87`）。成功后从 `poll` 读 `content.last_frame_url`（`ark:256`），随返回值给出并在下载日志里附一行（`ark:361-362`）。**末帧不会被下载**；`ark:1034` 标注「是否真的返回未实证」 |
| first-last-frame | 模式三选一，可显式给也可由 `lastFrame` 推断（`gen-actions:195`、`ark:757-770`）。`content` 顺序固定：text → first_frame → last_frame（`ark:798-822`）。本地图按扩展名映射 MIME 转 base64（`ark:63-72,833-851`）；扩展名不受支持会报错并列出可用扩展名（:843-849）。三处互斥校验保证：「t2v 不给图、i2v 不给末帧、flf 两帧都要」（:784-822）。**注意参考图不能是公网 URL**（见上） |
| 轮询与超时 | 间隔默认 15 s、总预算默认 900 s（`ark:305-306`，可由参数或配置覆盖：`gen-actions:228-229`、`index.mjs:94-95`）。每轮报 `status`/已等待秒数/轮次（`gen-actions:242-244`）。终态 `failed/expired/cancelled` 立刻抛错并带服务端信息（`ark:940-949`）；超时抛 `code: PollTimeout`，含 jobId 与最后状态（`ark:926-932`）。提交与下载两段 HTTP **没有超时设置**（`ark:598-632,859-876`） |
| 成本量级 | **代码里没有任何价格/计费常量**（全仓 `价格/计费/成本` 只命中 `docs/插件设计规格.md`，其中 :825 明确「价格未查」）。可用的量级依据只有：① 返回的 `usage`（视频 `ark:383`、图像 `:495`）；② 实测墙钟与 token（4 s/480p 视频 ≈87 s、40594 completion tokens，README:453 与 `docs/插件设计规格.md:825`；2K 图 ≈12 s、`total_tokens: 16224`，`docs/插件设计规格.md:868-876`）；③ 两个显式的省钱开关 `draft` 与 `serviceTier: "flex"`（`gen.mjs:67,68-72`）；④ 本地先拒的尺寸校验，作用是「越界在花钱之前就报错」（`ark:505-509`、README:467）；⑤ 图像端点**没有免费试参数**（`docs/插件设计规格.md:900-903`）。所以：**成本只能从模型 id + duration/resolution + usage 事后核算，不要指望工具预估** |

---

## 附：两个工具最容易误判的相邻关系

1. `video_narrate` 的产物是**素材**（mp3/srt/样式数值），消费方是 `video_plan` + `video_render`：音频进 `audio.voiceover`，SRT 进 `subtitles.source`（只认 `.srt`/`.ass`），样式进 `subtitles`。
2. `video_gen` 的产物也是**素材**（本地图片/视频），消费方是 plan.json 的镜头 `source`。两个工具都**不做编排决策**（`src/tools/shared.mjs:10-14`、`src/tools/gen.mjs:4-6`）。
