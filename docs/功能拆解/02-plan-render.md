# plan / render 家族功能拆解

> **本文性质**：只读功能拆解，未运行任何渲染。所有事实来自源码，行号为当前工作区 HEAD 的行号。
>
> **已读文件**：`src/tools/plan.mjs`、`src/tools/plan-actions.mjs`、`src/tools/render.mjs`、`src/tools/render-actions.mjs`、`src/core/plan.mjs`、`src/core/pipeline.mjs`、`src/core/scene.mjs`、`src/core/assemble.mjs`、`src/core/finalize.mjs`、`src/core/deliver.mjs`、`src/core/proxy.mjs`、`src/assets/PLAN-FIELDS.md`。
> **为核对"参数是否真的被消费"另读了**：`src/tools/shared.mjs`、`src/core/probe.mjs`、`src/core/ffmpeg.mjs`、`src/core/filter.mjs`、`index.mjs`（取 `config.pathBudget` 默认值）。
>
> **不确定的一律标注**：真实墙钟耗时、真实渲染结果无法从代码读出，写「未证实」。凡"由代码推导但未运行验证"的结论都单独注明。
>
> **`src/core/proxy.mjs` 与 plan/render 无调用关系**：它只被 `src/core/install.mjs:21,74` 和 `src/core/ws.mjs:33,315` 使用（grep 可证），不在渲染链上，本文不再展开。

---

## 工具 video_plan

**一句话定位**：`video_plan` 是 plan.json 的确定性检查器——只判断计划是否合法、时间轴多长、引用的文件在不在，**从不写计划、从不修计划、从不渲染**（`src/tools/plan.mjs:15-38`、`src/tools/plan-actions.mjs:1-11`）。

**何时用**：写完 plan.json（或还没落盘、只有内存对象）之后立刻 `check`；需要精确时间轴长度对齐配音时 `duration`；需要字段速查时 `fields`；渲染前想知道"这份计划客观上有哪些毛病"时 `diagnose`。

**何时不该用**：

- 别指望它补全或修正计划：`normalized` 只是回显已生效的默认值（`src/tools/plan-actions.mjs:192-202`），不写回任何文件。
- 别把 `check` 通过当成"一定能渲染"：chroma_key / matte 的可用性与互斥、字幕文件格式、`source:"auto"` 都不在检查范围内（详见 §check、§diagnose 的陷阱）。
- 别用 `diagnose` 求创作意见：它显式不报"该不该换顺序、该不该改节奏"（`src/tools/plan.mjs:24-25`）。

### 公共参数（`video_plan` schema 的全部字段，`src/tools/plan.mjs:27-36`）

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `action` | string，枚举 | 是 | — | `check` / `duration` / `fields` / `diagnose`（`src/tools/plan.mjs:26`） |
| `plan` | string | 否 | — | plan.json 路径。与 `planData` 二选一 |
| `planData` | object（任意键） | 否 | — | 内联计划对象，用于"落盘前先查一遍" |
| `strict` | boolean | 否 | `false` | **只对 `check` / `diagnose` 有效**：findings 也算失败（`src/tools/plan-actions.mjs:189,246`） |
| `cwd` | string | 否 | 宿主给的上下文 cwd，缺省 `process.cwd()`（`src/tools/shared.mjs:101`） | 相对路径基准 |

schema 层面 `required: ['action']`、`additionalProperties: false`（`src/tools/shared.mjs:80-81`）：未知字段会被宿主直接拒绝；未知 `action` 抛 `video_plan: unknown action "..."; expected one of ...`（`src/tools/shared.mjs:86-89`）。

**四个 action 共用的输入解析规则**（`planFrom`，`src/tools/plan-actions.mjs:58-78`）：

1. `planData` 优先于 `plan`：两者同时给，只用 `planData`（`:59` 与 `:67`）。
2. `planData` 的 `baseDir` = **`context.cwd`**；`plan` 的 `baseDir` = plan.json 自己的目录（`src/core/plan.mjs:534`）。所以"内联检查通过、把同一份计划写到别的目录再跑却找不到素材"就是这个差异造成的。
3. **`plan`（路径）是用 `path.resolve(path)` 解析的，基准是插件进程的 `process.cwd()`，不是 `cwd` 参数**（`src/core/plan.mjs:518`）。只有 `planData` 里的相对素材路径才走 `cwd`。两者通常相同，因此这个不一致很容易被忽略。
4. 读文件时剥掉 BOM（PowerShell 默认写 UTF-8 会带 BOM，`src/core/plan.mjs:527`）；坏 JSON 抛 `<绝对路径>: invalid JSON: ...`（`:532`）。
5. 校验失败统一抛 `PlanError`，被包成 `VideoFactoryError`：`planData` 分支加前缀「计划校验失败：」（`src/tools/plan-actions.mjs:63`），`plan` 分支不加前缀（`:71`）。
6. 两者都没给：抛 `video_plan: 需要 "plan"（plan.json 路径）或 "planData"（内联计划对象）。可用画布预设：...`（`:75-77`）。

### action: check

- **用途**：一次调用拿到全部结构错误 + 客观 findings + 生效后的关键字段，是写计划后的第一道闸。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` | string | 否 | — | ✔ 与 `planData` 二选一 |
| `planData` | object | 否 | — | ✔ 优先于 `plan` |
| `strict` | boolean | 否 | `false` | ✔ 决定 `ok` 是否把 findings 算作失败 |
| `cwd` | string | 否 | `process.cwd()` | ✔ 仅影响 `planData` 内相对路径 |

- **行为细节**：
  - 没给计划 → **抛错**（调用错误），不是返回 `ok:false`：`if (!hasPlanInput(args)) planFrom(args, context.cwd)`（`src/tools/plan-actions.mjs:172`）。`hasPlanInput` 的判定：`planData` 非 `undefined/null`，或 `plan` 是非空字符串（`:43-46`）。
  - 计划非法 → **不抛**，返回 `{ok:false, errors:[失败原因], findings:[], normalized:null}`（`:174-179`）。这是刻意的：错误文案就是模型修计划所需的输入（`:170-171`）。
  - `errors[]` 只来自 `missingFiles(plan, existsSync)`（`:184`）——即**引用文件不存在**：`scenes[<id>].source`、`scenes[<id>].generate.reference`、`scenes[<id>].generate.last_frame`、`audio.voiceover`、`audio.music`、`subtitles.source`（`src/core/plan.mjs:553-582`）。`kind:"color"` 的镜头全部跳过（`:556`）；`subtitles.source === "auto"` 不做存在性检查（`:575-577`）。
  - `findings[]` 与 `diagnose` 完全同源（同一函数），清单见 §diagnose。
  - `ok = errors.length === 0 && (!strict || findings.length === 0)`（`:189`）。**非 strict 时 `ok:true` 仍可能带着一堆 findings。**
  - 结构校验全在 `parsePlan`（`src/core/plan.mjs:417-466`）：顶层必须是非数组对象；`version` 必须 === 1（缺省视为 1）；`meta.preset` 必须是 5 个预设之一或省略；`width`/`height` 64–7680 且截断取整、`fps` 1–120；`scenes` 至少 1 个；`id` 全局唯一（重复抛 `duplicate scene id '...'`）；`meta.quality` ∈ {high, medium, draft}。`numberField` 显式**拒绝布尔**（`true` 不是时长，`:100-103`）。
  - 取值域（节选，`src/core/plan.mjs`）：`scene.duration` 0.2–600（`:305`）、`speed` 0.1–10（`:302`）、`volume` 0–4（`:303`）、`transition.duration` 0–5（`:231`）、`overlay.font_size` 8–400（`:212`）、`overlay.margin` 0–2000（`:215`）、`chroma_key.similarity` 0.01–1 且 `similarity + blend ≤ 1`（`:150,159-163`）、`matte.mask_fps` 0.5–30（`:188`）、`matte.feather` 0–24（`:196`）、`audio.music_gain_db` −60..12（`:324`）、`subtitles.font_size` 8–200（`:346`）。
  - 只读：不写文件、不建目录、不渲染。有错误时额外写一条 warn 日志 `video_plan check: N 个错误`（`:186`）。
  - 断链规则：`kind !== "color"` 且既没有 `source` 也没有 `generate` → `<where>: needs 'source', 'color', or 'generate'`（`:278-280`）。

- **输出**：

| 字段 | 含义 |
| --- | --- |
| `ok` | 见上面公式；`strict` 影响它 |
| `errors[]` | 缺失文件清单，每条带字段名 + 绝对路径 |
| `findings[]` | 客观观察（中文句子），空数组表示没有观察 |
| `normalized.title / preset / width / height / fps / quality / sceneCount` | 补默认值后的生效值；未指定 preset 时为 `"custom"` |
| `normalized.estimatedDuration` | 时间轴秒数，**已扣转场重叠**，保留 3 位小数（`src/core/plan.mjs:379-386`） |
| `normalized.subtitleSource` | `subtitles.enabled` 为真时给 `source`，否则 `null` |

- **代价**：不写磁盘、不渲染，但**不是纯计算**：每个 `kind:"image"` 且 `resolved !== null` 的镜头各跑一次 ffprobe（用于方向诊断，`src/tools/plan-actions.mjs:108-116`），有配音时再跑一次（`:128`）。每次 `probe()` 会 spawn 一个 ffprobe 进程（`src/core/probe.mjs:149-161`）。此外还有若干 `existsSync` 与一次 `readFileSync`（读 plan.json）。

- **失败与陷阱**：
  - 只给 `action` 不给计划 → 抛错；模型容易把它读成"检查通过"。
  - `ok:false` 且 `errors` 非空时 `findings` **仍然会返回**（`:183-185`），别只看 `errors` 就动手改。
  - `check` **不会**报：`chroma_key` 缺 `background`、`chroma_key` 与 `overlays` 同用、`chroma_key` 与 `matte` 同用、`matte` 缺 `background`、`matte` 模型未安装、`background` 写成了文件路径、`subtitles.source:"auto"`。这些全部在渲染期才炸（见 §scene、§finalize）。
  - 只跑 `existsSync`，不验证文件内容是否真是可解码的媒体；`source` 指向一个目录或坏文件时 `check` 通过、`scene` 失败。
  - `diagnose` 的外层提示与 `check` 不同：计划非法时 `check` 返回结果，`diagnose` 抛异常。

- **典型用法**：
  ```json
  { "action": "check", "plan": "out/plan.json", "strict": true }
  ```
  落盘前查内联对象：
  ```json
  { "action": "check", "planData": { "meta": { "preset": "vertical-short" }, "scenes": [ { "kind": "color", "color": "#101010", "duration": 2 } ] } }
  ```

- **相邻动作**：`check` → 修计划 → 再 `check`；确认无误后转 `video_render {action:"build"}`。也可以先 `duration` 对一遍旁白长度。

### action: duration

- **用途**：给出精确时间轴长度与每个边界实际生效的重叠量，用于把画面时长对齐到配音。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` | string | 否 | — | ✔ 与 `planData` 二选一 |
| `planData` | object | 否 | — | ✔ |
| `strict` | boolean | 否 | `false` | ✘ 完全无效 |
| `cwd` | string | 否 | `process.cwd()` | ✔ 仅影响 `planData` 内相对路径 |

- **行为细节**：
  - `estimatedDuration = Σ场景时长 − Σ有效重叠`（`src/core/plan.mjs:379-386`），**含转场重叠扣减**。
  - 有效重叠 = `min(转场时长, 本镜时长×0.5, 上一镜时长×0.5)`（`src/core/plan.mjs:368-372`）；`type:"none"` 或 `duration<=0` 时为 0。所以短镜头不会被自己的转场吃掉（`src/assets/PLAN-FIELDS.md:134`）。
  - `sumOfScenes` 是不扣重叠的裸和，用来一眼看出总共扣了多少。
  - 不做任何文件存在性检查（与 `check` / `diagnose` 的关键差别）。

- **输出**：`{estimatedDuration, sceneCount, sumOfScenes, perScene:[{id, duration, transition, effectiveOverlap}]}`，数值保留 3 位小数（`src/tools/plan-actions.mjs:213-224`）。

- **代价**：纯计算 + 读一次 plan.json（传 `planData` 时连磁盘都不读）。无 ffprobe、无写入。

- **失败与陷阱**：
  - **已知崩溃点（代码可证）**：`perScene` 对**每一个**下标调用 `effectiveOverlap(plan.scenes, index)`（`:222`），而 `effectiveOverlap` 在下标 0、`scenes[0].transition.type !== "none"` 且 `duration > 0` 时会去读 `scenes[-1].duration` → `undefined.duration` → 抛原生 `TypeError`（`src/core/plan.mjs:368-372`）。渲染链不会踩到它（`transitionOffsets` 从下标 1 开始，`src/core/plan.mjs:396`；`estimatedDuration` 只在 `index > 0` 时扣，`:383`），**只有 `duration` 这个 action 会**。也就是说：给第一个镜头写了转场，就会让 `duration` 报 TypeError。首个镜头的转场在渲染里本来也被完全忽略（`transitionOffsets` 不看下标 0）。测试只覆盖了下标 1（`tests/plan.test.mjs:166,181,188`），本崩溃点未见测试覆盖。
  - 无计划输入时抛 `VideoFactoryError`，不返回 `ok:false`。

- **典型用法**：
  ```json
  { "action": "duration", "plan": "out/plan.json" }
  ```
  返回形状：`{ "estimatedDuration": 12.5, "sceneCount": 4, "sumOfScenes": 14.0, "perScene": [ { "id": "s01", "duration": 3, "transition": "none", "effectiveOverlap": 0 }, ... ] }`

- **相邻动作**：`duration` 与 `video_narrate` 的配音时长对不上 → 改 `scenes[].duration` → 再 `duration` → 再 `check`。

### action: fields

- **用途**：把打包的字段速查（`src/assets/PLAN-FIELDS.md` 全文）返回给模型，省一次文件读取。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` / `planData` / `strict` / `cwd` | — | 否 | — | ✘ 全部无效（handler 不接参数，`src/tools/plan-actions.mjs:231-233`） |

- **行为细节**：每次调用 `readFileSync` 读 `src/assets/PLAN-FIELDS.md`（`src/core/plan.mjs:593-596`），返回 `{version: 1, text: <全文>}`。`version` 是硬编码的 1，与 plan 的 `version` 无关。

- **输出**：`{version, text}`，`text` 是 Markdown 全文。

- **代价**：一次磁盘读。无 ffprobe、无写入、无渲染。

- **失败与陷阱**：
  - 资产文件缺失 → 抛原生 `ENOENT`（未包装成中文错误）。
  - **正文与实现有出入，照抄会踩坑**（均由 grep 证实：这些字段只在 `plan.mjs` 里被解析，没有任何渲染代码消费）：
    - `audio.duck_amount`：解析于 `src/core/plan.mjs:326`；`finalize` 的 `sidechaincompress` 用固定参数 `threshold=0.03:ratio=8:attack=5:release=300:makeup=1`（`src/core/finalize.mjs:112`）→ **改它不改变成片**。
    - `subtitles.bold`：解析于 `src/core/plan.mjs:351`；`subtitleStyle` 的 force_style 里没有 `Bold`（`src/core/filter.mjs:461-467`）→ **无效**。
    - `subtitles.max_chars_per_line`：解析于 `src/core/plan.mjs:352-355`；烧字幕路径没有消费者（`subtitleStyle` 不含换行控制）→ **无效**。
    - `subtitles.source: "auto"`：文档写"由配音自动生成"，`diagnose` 明确说本插件不自动生成（`src/tools/plan-actions.mjs:145-147`），渲染期则把它当路径 → `找不到字幕文件：auto`（`src/core/finalize.mjs:35`）。
    - `chroma_key.background`：文档说"目前仅支持 `#RRGGBB` 纯色"，实际校验在渲染期的 `chromaKeyComposite`（`src/core/filter.mjs:151-162`），`plan check` 不校验它。
  - `fields` 是文档，不是校验器：`fields` 看过不代表计划合法。

- **典型用法**：`{ "action": "fields" }`

- **相邻动作**：`fields` 查字段 → 写计划 → `check`。

### action: diagnose

- **用途**：只报客观问题的体检；相比 `check`，把缺失文件单独放在 `missingFiles` 里。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` | string | 否 | — | ✔ 与 `planData` 二选一 |
| `planData` | object | 否 | — | ✔ |
| `strict` | boolean | 否 | `false` | ✔ **只影响 `ok`**，不影响 findings 内容 |
| `cwd` | string | 否 | `process.cwd()` | ✔ 仅影响 `planData` 内相对路径 |

- **行为细节**（findings 的完整判定清单，`src/tools/plan-actions.mjs:87-153`；`check` 复用同一函数）：
  1. 遍历场景，**只看 `kind === "image"`**（`:90-91`）：
     - `motion === "none"` → `scenes[<id>].motion 是 "none"：静止图没有运动会显得呆板`（`:92-94`）。
     - `transition.type !== "none" && transition.duration > duration * 0.5` → 报"超过该镜头时长的一半（Xs），实际会被裁剪到 X/2 s"（`:95-100`）。**因为 `continue` 在前，视频镜头的过长转场不会被报。**
  2. 方向混用（`:104-123`）：对每张 `kind === "image"` 且 `resolved !== null` 的图跑 ffprobe；`portraitCanvas = plan.height > plan.width`，若"图是横向"与"画布是竖屏"同真（`portraitCanvas === landscape`）就计入不匹配（`:112`）。`mismatched > 0` 时报 `N/M 张静止图的方向与画布相反（画布 WxH），会被 fit 裁切；如果取景重要，考虑 fit: "contain" 或 "blur-pad"`。probe 失败被吞掉（`:113-115`，缺失文件另有 `missingFiles` 报）。
  3. 配音时长（`:126-140`）：`audio.voiceover !== null && existsSync(...)` 时 probe 它，`delta = estimatedDuration - voice.duration`；`|delta| > max(2, voice.duration * 0.15)` 时报 `时间轴 X s 与配音 Y s 相差 Z s，画面与旁白会对不齐`。probe 异常被吞（`:137-139`）。
  4. `subtitles.enabled && source === null` → "渲染时不会有字幕"（`:142-144`）。
  5. `subtitles.enabled && source === "auto"` → "本插件不会自动生成字幕；请先用 video_narrate 产出 .srt 并填入路径"（`:145-147`）。
  6. `audio.voiceover === null && audio.keepSceneAudio === false` → "成片会几乎没有声音"（`:148-150`）。
  7. `ok = strict ? (missing.length === 0 && findings.length === 0) : missing.length === 0`（`:246`）。**非 strict 时 `ok:true` 可以与一堆 findings 并存。**

- **输出**：`{ok, missingFiles[], findings[], sceneCount, estimatedDuration}`（`:245-251`）。`missingFiles` 与 `check` 的 `errors` 同源同文案；`findings` 与 `check` 的 `findings` 同源。

- **代价**：磁盘读（plan）+ 每张静止图 1 次 ffprobe + 有配音时 1 次 ffprobe。不写文件、不渲染。

- **失败与陷阱**：
  - 与 `check` 不同，**计划非法时 `diagnose` 直接抛错**（`:242` 的 `planFrom` 没有被 try 包住），没有 `ok:false` 这条路。
  - **它不报 chroma_key / matte 的任何问题**。`src/core/scene.mjs:261` 的注释声称"`diagnose` reports that combination instead"（指有 key 无 background），但 `plan-actions.mjs` 全文不含 `chroma` / `matte` / `background` 字样（grep 可证），`tests/` 里也没有 `diagnose` 的测试（grep `diagnose` 只命中 `tests/filter.test.mjs:5` 的一句英文注释）。因此"用了 `chroma_key` 却不给 `background`"只能等渲染期报错。
  - "文件不存在"在 `missingFiles` 里，不在 `findings` 里；只看 `findings` 会漏。
  - `motion:"none"` 只对 `kind:"image"` 报。给 `kind:"video"` 写 `motion` 不会被提示，而视频分支根本不读 `motion`（`src/core/scene.mjs:184-243`）。
  - `findings` 是观察不是错误：非 strict 下 `ok:true` 仍可能列出"静止图没运动"这类问题，别把它当阻断。

- **典型用法**：
  ```json
  { "action": "diagnose", "plan": "out/plan.json", "strict": true }
  ```

- **相邻动作**：`diagnose` 清掉客观问题 → `check` → `build`；成片后再用 `video_inspect {action:"verify"}` 做"成片 vs 计划"的验收（与 `diagnose` 的"计划 vs 素材"互补）。

---

## 工具 video_render

**一句话定位**：`video_render` 是 ffmpeg 执行层，把一份计划确定性地渲染成 `final.mp4` + `cover.jpg` + `contact-sheet.jpg` + `build-report.json`；它不做任何创作决策，同一份计划永远产出同样的文件（`src/tools/render.mjs:22-47`）。

**何时用**：计划已通过 `video_plan check`（至少 `errors` 为空）、素材都在磁盘上、`video_env {action:"probe"}` 确认 ffmpeg/ffprobe 可用之后。

**何时不该用**：

- 计划还没合法：渲染阶段只做"文件在不在"的检查，schema 校验是顺带做的（`planFrom`），错误会以各阶段自己的文案冒出来。
- 素材缺失：`missingFiles` 不参与渲染，报错分散到各阶段。
- **plan 里写了 `generate` 块**：`video_render` 完全不读 `scene.generate`。grep 可证 `generate` 只出现在 `src/core/plan.mjs` 的解析（`:241-261,273-274`）、路径解析（`:490-500`）和存在性检查（`:560-565`）里，`scene.mjs` / `pipeline.mjs` / `render-actions.mjs` 一次都没读。素材必须先用 `video_gen` 生成、把返回的本地路径写进 `scene.source` 才能渲染。只写 `generate` 不给 `source` 时，`resolvePlanPaths` 把 `resolved` 置为 `null`（`src/core/plan.mjs:490-493`），视频分支退化成 `resolve(scene.resolved ?? scene.source ?? "")` = 当前工作目录（`src/core/scene.mjs:158`），随后 ffprobe 一个目录而失败（**由代码推导，未运行验证**）。`video_gen` 只把结果落到 `generated/` 并按 `sceneId` 命名，不回写 plan.json。
- 想让它"顺手改一下计划"：不会。`prepare` 除了把 `args.quality` 覆盖进内存里的 `plan.quality`（`src/tools/render-actions.mjs:76`）之外不改任何字段，也不写回 plan.json。

### 公共参数（`video_render` schema 的全部字段，`src/tools/render.mjs:34-45`）

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `action` | string，枚举 | 是 | — | `scene` / `assemble` / `finalize` / `deliver` / `build`（`src/tools/render.mjs:33`） |
| `plan` | string | 否 | — | plan.json 路径；与 `planData` 二选一 |
| `planData` | object（任意键） | 否 | — | 内联计划；相对路径以 `cwd` 为基准 |
| `sceneId` | string | 否 | — | **只对 `scene` 有效**：只渲染该 id，例如 `"s03"` |
| `outDir` | string | 否 | plan.json 同级的 `output/`（内联 `planData` 时是 `<cwd>/output`） | `final.mp4`、`cover.jpg`、`contact-sheet.jpg`、`build-report.json` 的落点 |
| `workDir` | string | 否 | `<outDir>/.work` | 中间产物目录（片段、时间线、字体、字幕、遮罩） |
| `clips` | string[] | 否 | 计划顺序的 `<workDir>/scenes/NNN_<id>.mp4` | **只对 `assemble` 有效**：显式片段列表，相对 `cwd` 解析 |
| `timeline` | string | 否 | `<workDir>/timeline.mp4` | **只对 `finalize` 有效**。schema 描述写的是 "finalize / deliver"，但 `deliver` handler 从不读它（`src/tools/render-actions.mjs:195-207` 只认 `outDir/final.mp4`） |
| `quality` | string，枚举 | 否 | 计划里的 `meta.quality` | `high` / `medium` / `draft`；覆盖 `plan.quality`（内存覆盖）。**只影响 `finalize` 的编码**，不影响中间片段的 CRF（中间片段恒定 `MEZZANINE_CRF=16`，`src/core/scene.mjs:29`） |
| `force` | boolean | 否 | `false` | 忽略缓存重做该阶段。**`deliver` 没有缓存，`force` 对它无效** |
| `cwd` | string | 否 | 宿主给的 cwd，缺省 `process.cwd()` | 相对路径基准 |

schema：`required: ['action']`、`additionalProperties: false`（`src/tools/shared.mjs:80-81`）。另有一个非工具参数的配置项 `config.pathBudget`（默认 200，`index.mjs:88`），由 `scene` action 传给 `checkPathBudget`。

### 参数 × action 有效性矩阵（✔ = 会被读取，✘ = 完全无效）

| 参数 | `scene` | `assemble` | `finalize` | `deliver` | `build` |
| --- | --- | --- | --- | --- | --- |
| `plan` / `planData` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `sceneId` | ✔ | ✘ | ✘ | ✘ | ✘（`build` 不传 `only`，**无法只渲一个镜头**） |
| `outDir` | ✔（只 mkdir） | ✔（只 mkdir） | ✔（写 `final.mp4`） | ✔（写三件套） | ✔ |
| `workDir` | ✔ | ✔ | ✔ | ✔（仅路径推导，不读） | ✔ |
| `clips` | ✘ | ✔ | ✘ | ✘ | ✘ |
| `timeline` | ✘ | ✘ | ✔ | ✘ | ✘ |
| `quality` | ✘ | ✘ | ✔ | ✘ | ✔（经 finalize 生效） |
| `force` | ✔ | ✔ | ✔ | ✘（无缓存） | ✔（传给前三段） |

**共用前置 `prepare`（`src/tools/render-actions.mjs:74-81`）**：五个 action 都先 `planFrom`（校验 + 解析路径）→ 用 `args.quality` 覆盖 `plan.quality` → 计算 `outDir`/`workDir` → `mkdirSync(workDir, {recursive:true})` **和** `mkdirSync(outDir, {recursive:true})`。因此连只跑 `scene` 也会创建 `outDir`。目录推导：`planDir = plan.baseDir ?? cwd`，默认 `outDir = resolve(planDir, 'output')`，默认 `workDir = join(outDir, '.work')`（`:31-42`）。

### action: scene

- **用途**：把一个（或全部）镜头渲染成**规格统一的中间片段**。这是整条链最贵、最需要重试的一步，也是"规格统一算子"：画布、帧率、像素格式、时间基、以及**长度恰好等于镜头时长的音轨**都在这里对齐（`src/core/scene.mjs:1-19`）。这一步的契约成立，后面的 concat / xfade 才安全。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` / `planData` | — | 二选一 | — | ✔ |
| `sceneId` | string | 否 | 全部镜头 | ✔ 只渲这一个 |
| `workDir` / `outDir` | string | 否 | 见公共参数 | ✔（目录） |
| `force` | boolean | 否 | `false` | ✔ 忽略已存在的片段 |
| `cwd` | string | 否 | `process.cwd()` | ✔ |
| `clips` / `timeline` / `quality` | — | — | — | ✘ |

- **行为细节**：
  - `sceneId` 过滤按计划顺序执行（`src/tools/render-actions.mjs:92-95`）；`sceneId` 不匹配任何 id → 抛 `video_render scene: 计划里没有 id 为 X 的镜头。可用：s01, s02, ...`（`:96-100`）。注意空字符串 `""` 视为"没给"，等于渲染全部。
  - 每个镜头走 `renderScene`（`src/core/scene.mjs:436-488`）：先 `mkdirSync(workDir/scenes)`，再 `checkPathBudget(workDir, plan.scenes.length, config.pathBudget)`；**已存在且 `size > 0` 且未 `force` → 直接复用，`reused:true, seconds:0`**（`:442-444`）。
  - 复用判定只看"文件存在且非空"，**不比较计划内容**（见 §缓存与 force 语义）。
  - 镜头级编码参数固定：`libx264 -preset veryfast -crf 16`（`MEZZANINE_CRF`）、`yuv420p`、`color_range tv`、`-profile:v high`、关键帧间隔 `round(fps*2)`、`aac 192k 48kHz 立体声`、`-video_track_timescale 90000`、`-fps_mode cfr`、`-t <镜头时长>`（`src/core/scene.mjs:454-466`）。
  - 三种来源分支（`src/core/scene.mjs:131-243`）：`color` 用 `lavfi color=` 合成并生成静音轨（`:145-156`，**颜色镜头也支持 `overlays`**）；`image` 用 `-loop 1 -framerate <fps> -t <duration>` 限制循环，`motion:"none"` 走 `fitFilters`，否则走 `motionFilters`（`:163-183`）；`video` 用 `-stream_loop -1` 重复不足长度的素材，`start` 会被夹到 `min(start, max(源时长-0.05, 0))`，`speed` 用 `setpts=/speed` + `atempoChain` 变速，音轨用 `atrim/aresample/apad` 补齐（`:184-243`）。
  - **文字永不内联进滤镜串**：overlay 文本先写成无 BOM 的 `ov_<sceneId>_<i>.txt` 并通过 `textfile=` 引用（`src/core/scene.mjs:112-116`），CJK 字体被复制成 `workDir/fonts/cjk.ttc` 再相对引用（`:69-79`）。
  - 该 action 结束才返回；单镜头 ffmpeg 超时 30 分钟（`src/core/scene.mjs:474`）。
  - 渲染后校验产出存在且非空，否则 `镜头 <id> 渲染后没有产出文件：<path>`（`:484-486`）。
  - `matte` 场景会先做遮罩推理（见 §代价与失败）。

- **输出**：

| 字段 | 含义 |
| --- | --- |
| `workDir` | 实际使用的工作目录 |
| `clips[]` | **计划里全部**镜头按顺序的片段路径（即使本次只渲了一个；未渲染过的路径此刻可能还不存在） |
| `rendered[]` | 本次实际处理的：`{sceneId, path, reused, seconds}` |
| `reusedCount` | 本次复用数 |
| `note` | 固定文案：`force` 开时为"force 已开启，全部重渲染"，否则"已存在的片段被复用；改动镜头参数后请传 force: true"（`src/tools/render-actions.mjs:120`） |

- **代价**：整条链里最重的一步，与镜头时长、分辨率、素材复杂度成正比（具体倍率**未证实**）。`matte` 是极端情况：每个遮罩一次模型推理，源码注明**实测约 2.1 秒/遮罩**（`src/core/scene.mjs:318-322`），PLAN-FIELDS 给出"30fps 成片按 8 遮罩/秒算约 26 分钟/分钟成片"（`src/assets/PLAN-FIELDS.md:111`）；20 秒镜头 @8 遮罩/秒 ≈ 5.6 分钟纯粹在推理，ffmpeg 还没启动。复用命中时秒级返回（`seconds: 0`）。会写：片段、`fonts/cjk.ttc`、`ov_*.txt`、`masks/<sceneId>/*`。

- **失败与陷阱**（错误文案与触发条件）：
  - `镜头 <id>：找不到素材 <path>`（`src/core/scene.mjs:159-161`）。
  - `镜头 <id> 渲染失败。\n<ffmpeg 错误：退出码/命令行/stderr 末 25 行>`（`:477-482`，`FFmpegError` 的格式见 `src/core/ffmpeg.mjs:39-51`）。
  - `镜头 <id> 渲染后没有产出文件：<path>`（`:484-486`）。
  - `工作目录太深，中间产物路径会超过 Windows 路径限制（N > 200 字符）：<workDir>。请换一个更浅的输出目录。`（`:91-98`；预算来自 `config.pathBudget`，默认 200）。
  - `镜头 chroma_key：暂不支持与 overlays 同时使用。...`（`:285-296`）——`chroma_key` + 文本叠加直接拒绝，不会产出时序错误的图。
  - `镜头 <id>：chroma_key 与 matte 不能同时使用。...`（`:204-209`）。
  - `镜头 <id>：matte 需要 background。抠像产生的是 alpha，不合成到某个背景上就没有可观察的结果。`（`:343-347`）；模型不可用时 `镜头 <id>：配置了 matte，但抠图模型不可用。<原因>`（`:339-342`）。
  - `chroma_key` 的 `background` 写成文件路径 → `镜头 chroma_key：chromaKey.background: '...' looks like a file path, ...`（`src/core/filter.mjs:159-163` 抛出，被 `src/core/scene.mjs:278-282` 包成 `BuildError`）。
  - **陷阱（最容易误判）**："改了镜头参数但成片没变"。片段缓存只看文件存在，**参数改动不会自动失效**，必须 `force: true`；而且必须**同时**给下游 `assemble`/`finalize` 也传 `force`，否则旧 `timeline.mp4`/`final.mp4` 会被复用（见 §缓存与 force 语义）。
  - **陷阱**：`kind:"generated"` 且没有 `source` 的计划不会被 `generate` 块驱动，会以 ffprobe 目录的形式失败（见 §何时不该用）。
  - 无 ffmpeg 时抛 `找不到 ffmpeg。请设置 VIDEO_FACTORY_FFMPEG，...`（`src/core/ffmpeg.mjs:71-75`）。

- **典型用法**：
  ```json
  { "action": "scene", "plan": "out/plan.json" }
  ```
  只重渲一个镜头：
  ```json
  { "action": "scene", "plan": "out/plan.json", "sceneId": "s03", "force": true }
  ```

- **相邻动作**：`scene` → `assemble`。只改了一个镜头时，`scene {sceneId, force:true}` 之后仍要 `assemble {force:true}` + `finalize {force:true}` 才会反映到成片。

### action: assemble

- **用途**：把已规范化的片段拼成一条时间线 `workDir/timeline.mp4`。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` / `planData` | — | 二选一 | — | ✔ 供转场与 fps 使用 |
| `clips` | string[] | 否 | 计划顺序的 `<workDir>/scenes/NNN_<id>.mp4` | ✔ 显式片段列表（相对 `cwd` 解析） |
| `workDir` / `outDir` | string | 否 | 见公共参数 | ✔ |
| `force` | boolean | 否 | `false` | ✔ 重建已存在的 `timeline.mp4` |
| `cwd` | string | 否 | `process.cwd()` | ✔ |
| `sceneId` / `timeline` / `quality` | — | — | — | ✘ |

- **行为细节**：
  - 工具层先检查显式/默认片段是否都存在，缺任何一个就抛错 **在调用核心之前**（`src/tools/render-actions.mjs:137-143`）：`video_render assemble: N 个片段还不存在，请先渲染它们。第一个缺失的是 <path>。（提示：先调用 video_render {action:"scene"}。）`
  - 核心 `assemble`（`src/core/assemble.mjs:40-148`）：
    1. **缓存优先**：`!force && existsSync(timeline.mp4) && size > 0` → 直接返回 `reused:true, detail:'复用缓存', seconds:0`（`:45-47`）。注意核心里的缓存判断**早于**片段存在性判断（`:49-51`），而工具层已经先查过片段了——所以通过工具调用时，缓存命中也不能掩盖缺失片段。
    2. `clips.length === 0` → `没有可拼接的片段`（`:48`）。
    3. **单镜头**直接 `copyFileSync`，不调 ffmpeg（`:53-56`，`detail:'单镜头'`）。
    4. 转场由 `transitionOffsets(plan.scenes)` 决定（`:58`）；**每帧转场偏移都来自计划，不是来自 `clips`**。
    5. 无转场 → concat demuxer + `-c copy -movflags +faststart`（`:61-87`，`detail:'无转场，流复制拼接'`），超时 30 分钟（`:75`）。写 `workDir/concat.txt`（正斜杠、无 BOM，`:62-68`）。
    6. 有转场 → 单个 `-filter_complex`：每路输入先 `settb=AVTB,setpts=PTS-STARTPTS`，硬切处用 `concat=n=2`，转场处用 `xfade=transition=<type>:duration=<有效重叠>:offset=<偏移>` + `acrossfade=d=<重叠>:c1=tri:c2=tri`；整条时间线编一次 `libx264 veryfast crf16 yuv420p`（`:89-127`），超时 60 分钟（`:135`），`detail:'N 个镜头带转场'`。
  - **首个镜头的 `transition` 被完全忽略**（`transitionOffsets` 从下标 1 开始，`src/core/plan.mjs:393-407`）。
  - `clips` 覆盖必须与 `plan.scenes` 数量、顺序一致：偏移与转场读的是 `plan.scenes[index]`；`clips` 比 `scenes` 长时会读 `plan.scenes[index]` 为 `undefined` → 抛原生 `TypeError`（`src/core/assemble.mjs:102`）；比 `scenes` 短时后面的转场被静默丢弃（**由代码推导，未运行验证**）。

- **输出**：`{stage:'assemble', detail, outputs:[timeline], seconds, reused, timeline}`（`src/tools/render-actions.mjs:151`）。

- **代价**：无转场时是流复制，接近磁盘 IO 成本（秒级）；有转场时是**整条时间线的一次 libx264 veryfast 重编码**，量级与成片长度成正比（具体倍率**未证实**）。会写 `timeline.mp4` 与无转场时的 `concat.txt`。

- **失败与陷阱**：
  - `video_render assemble: ... 片段还不存在 ...`（工具层，先于一切）。
  - `没有可拼接的片段`（核心，`:48`）。
  - `拼接所需片段不存在：<path>`（核心，`:49-51`）。
  - `流复制拼接失败。\n<ffmpeg 细节>`（`:79`）／`转场拼接失败。\n<ffmpeg 细节>`（`:139`）——两条文案把失败归因到"复制"还是"转场"。
  - **陷阱**：改了计划里的转场但没传 `force` → `detail:'复用缓存'`，旧时间线照旧。
  - **陷阱**：`clips` 与计划顺序不一致时，画面顺序按 `clips`，转场按 `plan.scenes`，两者会错位。
  - 传入的 `clips` 若来自别的 `workDir`，`outDir`/`workDir` 仍需一致，否则后续 `finalize` 找不到默认 `timeline`（可用 `timeline` 参数显式指定，但那只对 `finalize` 有效）。

- **典型用法**：
  ```json
  { "action": "assemble", "plan": "out/plan.json" }
  ```
  改了镜头后强制重建时间线：
  ```json
  { "action": "assemble", "plan": "out/plan.json", "force": true }
  ```

- **相邻动作**：`assemble` ← `scene`；`assemble` → `finalize`。修改计划后想生效，`assemble` 与 `finalize` 都要 `force`。

### action: finalize

- **用途**：唯一允许改动画面的编码步骤——混音（配音/音乐/场景声，含 sidechain 闪避）、EBU R128 响度归一、烧录或封装字幕，产出 `outDir/final.mp4`。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` / `planData` | — | 二选一 | — | ✔ |
| `timeline` | string | 否 | `<workDir>/timeline.mp4` | ✔ **唯一读取它的 action** |
| `quality` | string | 否 | 计划里的 `meta.quality` | ✔ 覆盖编码档位 |
| `outDir` / `workDir` | string | 否 | 见公共参数 | ✔ |
| `force` | boolean | 否 | `false` | ✔ 重编已有 `final.mp4` |
| `sceneId` / `clips` | — | — | — | ✘ |

- **行为细节**：
  1. 工具层先查 `timeline` 是否存在（`src/tools/render-actions.mjs:162-170`）→ `video_render finalize: 找不到时间线 <path>，请先调用 video_render {action:"assemble"}。`。注意这一步**早于**缓存判断。
  2. 核心缓存（`src/core/finalize.mjs:68-71`）：`!force && existsSync(outDir/final.mp4) && size > 0` → 直接 `probe` 它并返回 `reused:true, seconds:0`，且**恒定返回 `burned:false, softSubs:false`**——即使上一次确实是烧录字幕的，也别据此判断成片里有没有字幕。
  3. probe 时间线取 `duration`，用它当 `-t` 上限（`:74,195`）。
  4. 音轨构建：配音 `aresample=48000` 后 `asplit` 出侧链（`:84-96`）；音乐 `-stream_loop -1` 输入 + `volume=<music_gain_db>dB` + `atrim` + `afade in/out`（`:98-107`）；`duck` 为真且有配音时走 `sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300:makeup=1`（`:108-113`）；多轨用 `amix=...:normalize=0`（默认会把每路减半，`:136`）；`keep_scene_audio=false` 且有配音时剔除 `0:a`（`:120-123`）。
  5. 响度：一般情况下 `loudnorm=I=<loudness_target>:TP=-1.5:LRA=11`；当唯一音源就是场景静音且没有任何自带音轨时**跳过 loudnorm**，只 `aformat`（`:150-155`）。这是为了避免静音输入让 loudnorm 输出 NaN、被 AAC 编码器拒绝（`:125-131` 的注释）。
  6. 字幕：`stageSubtitles` 把 `.srt`/`.ass` 复制成 `workDir/vf_subs.srt|ass` 并剥 BOM、按 UTF-8 重写（`:32-44`）；`burn=true` 时把 `[0:v]` 接进滤镜图做 `subtitles='vf_subs.*'[:fontsdir='fonts']:force_style='...'` 并重编码，`burn=false` 时画面走 `-c:v copy`（`:159-175,184-192`）。
  7. 编码档位 `QUALITY`（`src/core/plan.mjs:60-64`）：`high=crf18/medium preset`、`medium=crf21/medium`、`draft=crf27/veryfast`；音频码率 `192k/160k/128k`。**画面 CRF 只在烧字幕时生效**（不烧字幕时 `-c:v copy`）；**音频码率无论烧不烧都生效**。
  8. 软字幕：`burn=false` 且有字幕时，先出 `outDir/final.softsub.mp4`（`-c copy -c:s mov_text`，`language=chi`），再 `copyFileSync` 覆盖 `final.mp4`（`:214-237`）。
  9. 超时：主编码 60 分钟（`:20,205`），软字幕封装 15 分钟（`:229`）。

- **输出**：`{stage:'finalize', detail:'X.Xs 成片', outputs:[final.mp4], seconds, reused, output, duration, subtitlesBurned, softSubtitles}`（`src/tools/render-actions.mjs:179-186`）。

- **代价**：**画面最多只在这里编码一次**。烧字幕 → 一次 libx264（`quality.preset`）；不烧字幕 → 画面流复制，只重建音频。软字幕额外一次近乎复制成本的封装。会写 `final.mp4`、`workDir/vf_subs.*`，软字幕时还会留下 `final.softsub.mp4`。

- **失败与陷阱**：
  - `找不到时间线 <path>`（工具层）／`找不到时间线：<path>`（核心，`:72`）。
  - `找不到配音文件：<path>`（`:86`）／`找不到背景音乐：<path>`（`:99`）／`找不到字幕文件：<path>`（`:35`）。
  - `合成失败。\n<ffmpeg 细节>`（`:209`）／`软字幕封装失败。\n<ffmpeg 细节>`（`:233`）。
  - **陷阱：`subtitles.source: "auto"` 会走到 `找不到字幕文件：auto`**，而不是"自动生成字幕"（`plan check` 只给 warning，不阻断）。
  - **陷阱：缓存命中时 `subtitlesBurned`/`softSubtitles` 恒为 false**，不能用它判断已有成片的内容。
  - **陷阱：`quality` 覆盖不失效缓存**——已有 `final.mp4` 时传 `quality:"draft"` 什么都不会发生，必须 `force:true`。
  - 一个**不可达的错误分支**：`finalize：没有任何音轨可混（keep_scene_audio 关掉了场景声，但也没有配音）`（`:145`）。当 `keepSceneAudio=false` 且存在配音时，`voc` 标签一定已被 push（`:92-95`），`effectiveLabels` 至少剩 1 项；没有配音时 `0:a` 不会被剔除。所以该文案在当前逻辑下不可能触发（**由代码推导，未运行验证**）。
  - 无 ffmpeg 时的错误同 §scene。

- **典型用法**：
  ```json
  { "action": "finalize", "plan": "out/plan.json" }
  ```
  只改字幕样式后重出成片：
  ```json
  { "action": "finalize", "plan": "out/plan.json", "force": true }
  ```

- **相邻动作**：`finalize` ← `assemble`；`finalize` → `deliver`。只改 `audio`/`subtitles` 时，重跑 `finalize {force:true}` 就够，不必回到 `scene`。

### action: deliver

- **用途**：写封面帧、缩略图总览和验收报告；`problems` 数组是对外必须转达的客观问题清单（`src/core/deliver.mjs:1-9`）。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` / `planData` | — | 二选一 | — | ✔ 供分辨率/时长/场景数与报告字段 |
| `outDir` / `workDir` | string | 否 | 见公共参数 | ✔ `outDir` 是输入（`final.mp4`）也是输出 |
| `cwd` | string | 否 | `process.cwd()` | ✔ 仅路径推导 |
| `sceneId` / `clips` / `timeline` / `quality` / `force` | — | — | — | ✘ **全部无效**（`timeline` 虽然 schema 描述提到 deliver，handler 从不读） |

- **行为细节**：
  - 输入固定为 `join(outDir, 'final.mp4')`，不存在或大小为 0 → 抛 `video_render deliver: 还没有成片 <path>，请先调用 video_render {action:"finalize"}。`（`src/tools/render-actions.mjs:197-202`）。
  - **没有任何缓存**：每次都会 probe + 抽封面 + 生成缩略图（`src/core/deliver.mjs:91-135`），`force` 无从生效。
  - 封面：`coverAt = min(1, duration/4)`（避开片头淡入），`-frames:v 1 -q:v 2` → `cover.jpg`（`:105-113`，超时 5 分钟）。
  - 缩略图：`columns = min(5, max(1, sceneCount))`、`rows = ceil(sceneCount/columns)`、`interval = max(duration/(columns*rows), 0.2)`，用 `fps=1/interval,scale=320:-2,tile=CxR` → `contact-sheet.jpg`（`:118-135`，超时 10 分钟）。
  - 验收 `verifyAgainstPlan`（`:47-76`）的六条规则：分辨率必须完全相等；fps 容差 0.5；时长容差 `max(1s, 估算值×6%)`；必须 `hasAudio`；像素格式必须 `yuv420p`；体积下限 `max(1000 字节, 像素×秒×0.01 bits/px/s ÷ 8)`（`:31-34,64-74`，为的是不误杀低复杂度的短片段）。
  - 报告写入 `outDir/build-report.json` 并原样返回（`:146-172`）。
  - `stages`：独立调用 `deliver` 时只有 `deliver` 一段（`options.stages ?? []`，`:138`）；经 `build` 调用时含前面四段。

- **输出**：`{output, cover, contactSheet, video:{width,height,fps,duration,pixFmt,videoCodec,audioCodec,hasAudio,sizeBytes,bitRate}, preset, quality, sceneCount, plannedDuration, title, stages[], problems[]}`（`src/core/deliver.mjs:146-169`）。**`problems` 为空数组才算干净交付**；非空时 handler 会额外写 warn 日志 `video-factory: 验收发现 N 个问题，必须转达给用户`（`src/tools/render-actions.mjs:208-210`）。

- **代价**：两次较浅的 ffmpeg 调用（固定时间点抽 1 帧、按 fps 抽帧再 tile），超时 5/10 分钟。**无缓存，重复调用重复付费**。会写 `cover.jpg`、`contact-sheet.jpg`、`build-report.json`。

- **失败与陷阱**：
  - `还没有成片 ...`（工具层）／`封面帧提取失败。\n<ffmpeg 细节>`（`src/core/deliver.mjs:114-116`）／`缩略图总览生成失败。\n<ffmpeg 细节>`（`:133-135`）。
  - **陷阱**：`problems` 非空时工具仍然"成功返回"——`ok` 字段并不在返回里，模型必须自己检查 `problems.length`。
  - **陷阱**：`deliver` 只认 `outDir/final.mp4`。若 `finalize` 时指定过别的 `outDir`，这里会报"还没有成片"。
  - **陷阱**：单独调 `deliver` 得到的 `stages` 不含前三段，别用它推断渲染过程。

- **典型用法**：
  ```json
  { "action": "deliver", "plan": "out/plan.json" }
  ```

- **相邻动作**：`deliver` ← `finalize`。`problems` 非空时，按字段名回到对应阶段修复，再 `finalize {force:true}` + `deliver`。

### action: build

- **用途**：按 `scene → assemble → finalize → deliver` 顺序跑完整条链，返回交付报告。它不做任何决策，只执行（`src/core/pipeline.mjs:79-119`）。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 本 action 是否读取 |
| --- | --- | --- | --- | --- |
| `plan` / `planData` | — | 二选一 | — | ✔ |
| `outDir` / `workDir` | string | 否 | 见公共参数 | ✔ |
| `quality` | string | 否 | 计划里的 `meta.quality` | ✔（经 `prepare` → `finalize`） |
| `force` | boolean | 否 | `false` | ✔ 传给前三段；`deliver` 无缓存 |
| `cwd` | string | 否 | `process.cwd()` | ✔ |
| `sceneId` / `clips` / `timeline` | — | — | — | ✘ **无效**：`build` 不传 `only`，**一次只能整链全渲，不能只重渲一个镜头** |

- **行为细节**：`normalizeScenes`（渲染**全部**镜头，返回按计划顺序的全部片段路径与 `normalize` 阶段耗时）→ `assemble(normalized.clips, plan, {force})` → `finalize(timeline.path, plan, {force})` → `deliver(finished.path, plan, {stages})`（`src/core/pipeline.mjs:83-118`）。`workDir` 默认 `<outDir>/.work`（`:80`）。进度回调会把 `phase:'scene'` 的镜头事件转成日志 `video-factory: 渲染镜头 <id>（i/N）`（`src/tools/render-actions.mjs:228-230`）。

- **输出**：与 `deliver` 完全相同的报告（含四段 `stages` 与 `problems`）。

- **代价**：四段之和。**它是唯一"一键"入口，但没有任何短路优化**：任何一段缓存未命中都会照常执行。相反，缓存的正确性是它的前提——不传 `force` 时，`build` 会复用已有的片段/时间线/成片，只跑失效的那几段（前提是那些缓存恰好是你想要的）。

- **失败与陷阱**：
  - 任一段失败即整链失败，报该段自己的文案；已经产出的中间产物留在磁盘上，重跑会从缓存续（这是重试便宜的原因）。
  - **陷阱**：`build` 对改动过的计划**不会自动失效任何缓存**。改了镜头参数又不传 `force`，`build` 会"成功"地返回一份旧成片——这是最危险的一种假成功。
  - **陷阱**：`build` 无法只渲一个镜头；想省时间必须自己按阶段调用。

- **典型用法**：
  ```json
  { "action": "build", "plan": "out/plan.json" }
  ```
  计划有改动、要真重渲：
  ```json
  { "action": "build", "plan": "out/plan.json", "force": true }
  ```

- **相邻动作**：`build` 是 `scene → assemble → finalize → deliver` 的语法糖；调试与增量更新请用分阶段调用。

### 四阶段（scene / assemble / finalize / deliver）与 build 的区别

| 维度 | `scene` | `assemble` | `finalize` | `deliver` | `build` |
| --- | --- | --- | --- | --- | --- |
| 产出 | `workDir/scenes/NNN_<id>.mp4` | `workDir/timeline.mp4` | `outDir/final.mp4`（+ 软字幕时 `final.softsub.mp4`） | `cover.jpg`、`contact-sheet.jpg`、`build-report.json` | 以上全部 |
| 缓存判定 | 片段存在且 size>0 | 时间线存在且 size>0 | `final.mp4` 存在且 size>0 | **无缓存** | 逐段同上 |
| `force` 作用 | 忽略已有片段重渲 | 忽略已有时间线重建 | 忽略已有成片重编 | **无效** | 传给前三段 |
| 失败归因 | `镜头 <id> 渲染失败` + stderr 末 25 行 | `流复制拼接失败` / `转场拼接失败` | `合成失败` / `软字幕封装失败` | `封面帧提取失败` / `缩略图总览生成失败` | 中止在该段，文案与单独调用一致 |
| 进程超时 | 30 分钟 | 30 分钟（复制）/ 60 分钟（转场） | 60 分钟（+ 软字幕 15 分钟） | 5 分钟 + 10 分钟 | 各段各自计时 |
| 主要成本 | 镜头数与时长（matte 场景可达分钟级/镜头） | 复制近乎免费；转场 = 全片一次重编码 | 烧字幕 = 全片一次重编码；否则只重建音频 | 两次浅抽帧 | 四段之和 |
| 可重试粒度 | **单个镜头** | 整条时间线 | 整片 | 无所谓（无状态） | 整链（但可续缓存） |

**分阶段调用的价值**：失败可归因（每段有自己的中文错误前缀）、重试便宜（改一个字幕样式不必重编所有镜头）、且 `scene` 的"规格统一"契约让 `assemble` 的流复制成为可能（`src/tools/render.mjs:1-17`）。`build` 只在"信任整链、想一次跑完"时用。

### 缓存的真实语义与 `force`

**代码事实**：不存在任何指纹（fingerprint）机制。三处缓存都是**"文件存在且非空就复用"**：

- `scene`：`!force && existsSync(target) && statSync(target).size > 0`（`src/core/scene.mjs:442-444`）
- `assemble`：`!force && existsSync(target) && statSync(target).size > 0`（`src/core/assemble.mjs:45-47`）
- `finalize`：`!force && existsSync(target) && statSync(target).size > 0`（`src/core/finalize.mjs:68-71`）
- `deliver`：无缓存。

**文档与实现的出入（务必注意）**：`src/tools/render.mjs:11-13` 写"Every stage caches on a fingerprint of the plan fields it depends on"、`src/tools/render-actions.mjs:5-7` 写"overrides the fingerprint-based reuse"、`src/tools/shared.mjs:37` 的 `force` 描述写"even when the fingerprint matches"、`docs/插件设计规格.md:349-357` 更明确描述了 `<clip>.meta.json` 旁车指纹。**这些都没有实现**：全仓库 grep `fingerprint` 只命中上述注释；grep `meta.json` / `sidecar` / `cacheKey` 在 `src/core` 下无命中（`createHash` 只出现在安装器与 TTS/WS 里）。

**由此产生的调用规则**：

1. **计划内容改动 = 缓存不失效**。改了镜头参数（时长、motion、fit、speed、overlays、source 内容替换…）后必须给对应的 `scene` 传 `force:true`。
2. **`force` 必须逐段传递**。只对 `scene` 传 `force` 只重渲片段；`assemble` 与 `finalize` 仍会复用旧的 `timeline.mp4`/`final.mp4`，成片不变。工具自己的 `note` 也只提醒了片段那一层（`src/tools/render-actions.mjs:120`）。
3. **`quality` 覆盖不失效缓存**：`final.mp4` 已存在时改 `quality` 无效，必须 `force:true`（`src/tools/render-actions.mjs:76` 只改内存里的 plan，`src/core/finalize.mjs:68` 仍会命中缓存）。
4. **换 `outDir`/`workDir` 等于全量重做**（新目录里没有任何缓存）。
5. `deliver` 没有缓存，随时可以重跑；它也只读 `outDir/final.mp4`。

### 各阶段的耗时量级与失败可归因性

量级只列代码里能证实的数字与超时上限；真实倍率**未证实**。

| 阶段 | 代码可证的量级 | 超时上限 | 失败归因方式 |
| --- | --- | --- | --- |
| `scene` | 主导成本，随镜头时长/分辨率/素材复杂度增长（倍率未证实）。`matte` 场景另加 **≈2.1 s/遮罩**（`src/core/scene.mjs:318-322`）；PLAN-FIELDS 给出"8 遮罩/秒 ≈ 26 分钟/分钟成片"（`src/assets/PLAN-FIELDS.md:111`） | 每镜头 30 分钟（`src/core/scene.mjs:474`） | `BuildError: 镜头 <id> 渲染失败。` + FFmpegError 的命令行与 stderr 末 25 行（`src/core/ffmpeg.mjs:39-51`）——**能直接指出是哪个镜头、哪条命令** |
| `assemble` | 无转场 ≈ 流复制（秒级）；有转场 = 整片一次 libx264 veryfast，随成片长度增长（倍率未证实） | 30 / 60 分钟 | `流复制拼接失败` 与 `转场拼接失败` 两条独立文案，能区分路径 |
| `finalize` | 烧字幕 = 整片一次 libx264（`high/medium` 用 `preset medium`）；不烧字幕 = 画面复制 + 音频重建，明显更便宜 | 60 分钟（+ 软字幕 15 分钟） | `合成失败`（主编码）与 `软字幕封装失败`（第二遍）分开 |
| `deliver` | 两次浅 ffmpeg：抽 1 帧 + 抽帧 tile | 5 + 10 分钟 | `封面帧提取失败` / `缩略图总览生成失败`；验收问题以结构化 `problems[]` 返回 |
| `build` | 四段之和 | 各段各自计时 | 中止在首个失败段，文案与单独调用一致；已完成的中间产物保留，重跑可续缓存 |

**归因性的关键**：任何一段失败都带 ffmpeg 的 stderr 尾巴，所以"滤镜串写错/素材坏/磁盘满"能直接从返回里区分；唯一不理想的是 `kind:"generated"` 无 `source` 这种"还没有素材"的情况会以 ffprobe 失败的形式出现（见 §何时不该用）。

### 什么时候只重渲一个镜头更便宜

判据是"改动落在哪一段"，因为四段的成本与缓存是分开的：

| 改动内容 | 最小必要调用 | 理由 |
| --- | --- | --- |
| 单个镜头的参数（时长/motion/fit/speed/overlays/muted）或素材文件内容被替换 | `scene {sceneId, force:true}` → `assemble {force:true}` → `finalize {force:true}` | 片段缓存按文件存在，必须 `force`；时间线与成片也必须重建。省下的是**其余 N−1 个镜头的重编码**（尤其省下其它 matte 场景的遮罩推理，那是分钟级的） |
| 只改转场类型/时长 | `assemble {force:true}` → `finalize {force:true}` | 转场只存在于计划里，片段不用重渲 |
| 只改 `audio`（配音/音乐/闪避/响度）或 `subtitles` | `finalize {force:true}` | 唯一改画面/声音的编码段；不烧字幕时画面甚至只是流复制 |
| 只改 `quality` | `finalize {force:true}` | 档位只在 finalize 生效 |
| 新增/删除镜头改变了片段数量 | `scene`（新增镜头）→ `assemble {force:true}` → `finalize {force:true}` | 时间线必须重建；已有片段可复用 |
| 什么都改了、或不确定缓存是否可信 | `build {force:true}` | 一键，代价最高但最不容易出现"假成功" |

**结论**：`N` 个镜头里只改 1 个时，分阶段调用省下的是"另外 `N−1` 个 `scene`"，这部分通常是整链成本的主体（matte 场景是绝对主体）；`assemble` 与 `finalize` 无论改多改少都是**整片**成本，所以它们从来不是"省一个镜头"能省的。反过来说：**只要涉及画面变化，`assemble` + `finalize` 这两段就必然要付**，所以"要不要只重渲一个镜头"的真正分界是——改动是否让片段本身失效。**未证实**：`xfade` 重编码相对单镜头编码的确切倍率，没有实测数据，本文不猜。
