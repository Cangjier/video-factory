# video-factory

**素材进，成片出。** 一个 DeepSeek Harness 插件：把图片、视频片段、音乐和一段文案，变成一条能直接发布的 mp4。

```
DSH 决定做什么  →  video_* 工具确定性地执行
```

**插件只提供确定性工具，流程与创作决策全部归 DSH。** 没有"一键出片"命令，因为镜头顺序、节奏、时长、选哪张图——这些都是创作判断，不该由工具替你决定。

- 调研背景、选型对比、成本与风险：[docs/方案调研报告.md](docs/方案调研报告.md)
- 工具清单、契约、设计取舍：[docs/插件设计规格.md](docs/插件设计规格.md)

---

## 工具

插件注册 6 个工具，共 26 个 action。每个工具的 schema 每轮都会进入模型上下文，所以按操作族分组、族内用 `action` 分派，而不是摊成二十多个独立工具。

| 工具 | action | 做什么 |
| --- | --- | --- |
| `video_env` | `probe` `presets` `scan` `install_ffmpeg` | 环境自检、画布预设、素材盘点、装 ffmpeg |
| `video_narrate` | `synthesize` `to_cues` `srt_write` `srt_read` `layout` `transcribe` | 文案→配音+逐词时间戳；断句；SRT 读写；字幕排版；**语音转文字** |
| `video_plan` | `check` `duration` `fields` `diagnose` | 计划校验、精确时长、字段速查、客观问题诊断 |
| `video_render` | `scene` `assemble` `finalize` `deliver` `build` | 单镜头、拼接、合成、交付、整链 |
| `video_inspect` | `verify` `media` | 成片验收、媒体元信息 |
| `video_gen` | `models` `generate` `image_models` `image` | 方舟模型发现；**文生视频**；**文生图** |

**先说清楚边界**：`scan` 只盘点不取舍（重复图**标注**而非删除）；`check` 只判断不修改；`diagnose` 只报客观事实（"静止图没给 motion"），不报品味（"这个镜头该放前面"）。`video_gen` 是**唯一不满足"同输入同输出"**的工具——同 prompt 不同结果，它是执行器不是确定性算子。

---

## 安装

插件已装进 `desktop` profile。装到别的 profile：

```powershell
# 用插件管理器，spec 指向本仓库
#   plugin_manager install_bundle  target = C:\Users\Admin\Documents\GitHub\video-factory
# 或手工：profile 的 package.json 加依赖与 bundle 行
#   "video-factory": "link:C:/Users/Admin/Documents/GitHub/video-factory"
```

装好后 `video_*` 工具**当场可用，不需要重启**（实测 `application: "applied"`）。

**修改插件源码后需要重启 DSH**：Node 按路径缓存 ES 模块，重新启用插件不会重新导入模块。

### ffmpeg

仓库自带 `vendor/ffmpeg/bin/`（BtbN GPL 静态构建，含 libx264/libx265/libass）。换机器时：

```
video_env {action: "install_ffmpeg"}
```

或用命令行：`node src/bin/vf.mjs install`。发现顺序是 `VIDEO_FACTORY_FFMPEG` 环境变量 → `vendor/ffmpeg/bin/` → `PATH`。

### 云端生成（可选）

只有火山方舟一家。需要环境变量 `ARK_API_KEY`——**且必须让 DSH 进程能看到它**（设成系统环境变量后重启 DSH）。没有 Key 时**只有 AI 生成不可用**，本地剪辑、配音、字幕全部照常。

商用前读一眼 `docs/方案调研报告.md` 第 4 节：Edge TTS 商用授权不明确，AI 生成内容有标识义务。

### 语音转文字（可选，需另开一个 bundle）

`video_narrate {action:"transcribe"}` 能读出**已有**视频或音频说了什么。它不自己实现识别，而是调用 DSH 自带的本地识别 Provider（SenseVoice + Silero VAD，**无需 Python、无需 GPU、完全离线**）。

**前提**：在「设置 → 插件管理」里启用 `@deepseek-ai/dsh-experimental-voice-input-bundle`，然后重启 DSH。

| 项 | 说明 |
| --- | --- |
| 首次使用 | 自动下载模型约 **239 MB**（INT8），校验 SHA-256，缓存到 `~/.dsh/speech-to-text/sensevoice`，之后完全离线 |
| 模型来源 | HuggingFace 与 HF-Mirror 双源自动探测，失败自动换源 |
| 语种 | `auto` / `zh` / `en` / `yue` / `ja` / `ko` |
| 单次上限 | 宿主限制每次请求 **4 MB**，约 131 秒；更长的音频会自动切分 |
| 切分策略 | 用 `silencedetect` 找**自然停顿**处切，避免切断词；找不到停顿才按上限硬切，并在返回值里标注 |
| 精度 | **整句级，没有逐词时间戳**（服务只支持完整录音转写）。要逐词精度请用 `video_narrate {action:"synthesize"}` |

没有启用时它不会让插件失效——只会明确提示你去启用哪个 bundle。

---

## DSH 能"看懂"一条视频吗？

能看画面，不能听声音——除非启用上面那个 bundle。分开说清楚：

| 能力 | 状态 |
| --- | --- |
| 看单张图 | ✅ 模型原生支持（`read_image`） |
| 从视频抽帧 | ⚠️ 要手动 `ffmpeg -ss` 或 `-vf fps=` |
| 逐帧扫全片 | ⚠️ 可行但慢、费上下文 |
| 语音转文字 | ✅ 启用语音 bundle 后，`video_narrate {action:"transcribe"}` |
| 听背景音乐 / 判断响度 | ❌ 只能读 ffprobe 的数值，听不了 |
| **判断运动感**（推拉快慢、卡点准不准） | ❌ **看静帧看不出来**，仍需人的眼睛 |

最后一条是本质限制：可以确认"这一帧画面对不对"，但判断不了"这个运镜舒服不舒服"。

---

## 用命令行

同一批操作也暴露成 CLI，便于调试和跑测试：

```powershell
node src/bin/vf.mjs doctor
node src/bin/vf.mjs scan examples/demo/material --json
node src/bin/vf.mjs check --plan examples/demo/plan.json
node src/bin/vf.mjs narrate --text script.txt --out narration
node src/bin/vf.mjs render --plan examples/demo/plan.json --all --out out
node src/bin/vf.mjs render --plan plan.json --scene s03 --force   # 只重渲染一个镜头
node src/bin/vf.mjs make-test-material --dir tmp/material --scenes 6
```

## 端到端验证

```powershell
node --test "tests/*.test.mjs"                                    # 96 个离线用例
node src/bin/vf.mjs render --plan examples/demo/plan.json --all --out examples/demo/out
node src/bin/vf.mjs probe examples/demo/out/final.mp4
```

跑完检查 `out/build-report.json` 的 `problems` 数组——**空数组才算干净交付**，非空必须翻译给用户。

---

## plan.json

计划是 DSH 与插件之间**唯一的契约**。完整字段速查：

```
video_plan {action: "fields"}
```

```jsonc
{
  "version": 1,
  "meta": { "title": "我的成片", "preset": "vertical-short", "quality": "medium" },
  "audio": { "voiceover": "narration/voiceover.mp3", "music": "素材/bgm.mp3",
             "music_gain_db": -20, "duck": true, "fade_out": 2.0 },
  "subtitles": { "enabled": true, "source": "narration/voiceover.srt", "burn": true },
  "scenes": [
    { "kind": "image", "source": "素材/01.jpg", "duration": 3.5, "motion": "zoom-in",
      "overlays": [{ "text": "开场标题", "anchor": "bottom-center" }] },
    { "kind": "video", "source": "素材/clip.mp4", "duration": 5.0, "fit": "cover", "start": 2.0,
      "transition": { "type": "fade", "duration": 0.5 } },
    { "kind": "color", "color": "#101820", "duration": 2.0 },
    { "kind": "generated", "duration": 5,
      "generate": { "mode": "text-to-video", "prompt": "清晨的城市天际线，缓慢推近", "resolution": "720p" } }
  ]
}
```

关键字段：`motion`（静止图运动，建议每镜轮换）、`fit`（`cover` 裁切填满 / `contain` 留黑边 / `blur-pad` 模糊填充）、
`transition`（进镜转场，**有效重叠 = min(转场时长, 本镜×0.5, 上一镜×0.5)**）、`duck`（说话时压低音乐）。

---

## 架构

```
index.mjs              插件入口：apply / inject / 工具注册
src/tools/*.mjs        工具 schema 与 action 实现（唯一知道 DSH 存在的层）
src/core/*.mjs         确定性内核：纯 ESM、零第三方依赖、可离线单测
vendor/ffmpeg/         静态 ffmpeg 构建
```

**内核不依赖 DSH**，所以"确定性"可离线证明。渲染分四阶段，每阶段独立可调、独立缓存：

| 阶段 | 做什么 | 缓存键 |
| --- | --- | --- |
| `scene` | 每个镜头统一画布/帧率/像素格式/时间基，**音轨长度精确等于镜头时长** | 镜头参数指纹 |
| `assemble` | 无转场走 concat 流复制；有转场走单条 `xfade` 滤镜图 | 画布+顺序+转场指纹 |
| `finalize` | 混音（sidechain 闪避）+ EBU R128 + 字幕烧录，**视频最多重编码一次** | 时间线+音频+字幕指纹 |
| `deliver` | 封面帧、缩略图总览、验收报告 | 每次重做（便宜） |

改一个字幕样式只有 `finalize` 重跑；改一个镜头只有那一个镜头重跑。

**为什么先统一规格**：concat demuxer 对 `time_base`、SAR、`pix_fmt`、音频采样率任何一项不一致都会**静默出错**——不是报错，而是画面卡住、音频错位、播放器在接缝处停下。统一规格是让后续操作安全的前提。

---

## 踩过的坑（都已在实现中修正）

| 坑 | 表现 | 处理 |
| --- | --- | --- |
| 只加 `-nostdin` 不加 `-y` | 重跑时 ffmpeg 要交互确认，退出码 1，stderr 只有一行 `Duration:` | 两者总是一起加 |
| ffprobe 不接受 `-y` | `Failed to set value '-y' for option 'nostdin'` | ffmpeg 与 ffprobe 用不同的前缀 |
| ffprobe 对损坏文件返回 **exit 0** | 只是把 width/height 报成 0，真错误在 stderr | `scan` 检查尺寸，不只看探测是否成功 |
| 本机 ffmpeg 无 fontconfig | 字体必须显式指定 | 把 CJK 字体拷进工作目录按相对路径引用 |
| 中文内联进滤镜串 | 被 BOM / 编码 / 冒号转义毁掉，静默渲染成空白 | 一律走 `textfile=`，绝不内联 |
| 滤镜图输出不能 stream copy | `Filtering and streamcopy cannot be used together` | 滤镜图只含音频时才能 `-map 0:v -c:v copy` |
| `amix` 默认减半 | 混音后半音量 | 总是 `normalize=0` |
| `zoompan` 整数栅格 | 静止图运动有可见抖动 | 先 4 倍超采样再 `zoompan` |
| 感知哈希分不清渐变 | 合成渐变图会被互相判为重复 | 已知限制，用真实照片测去重 |
| Windows 260 字符路径 | 超限报错极具误导性 | 提前检查路径预算（默认 200） |

完整清单见 `docs/插件设计规格.md` §5.3 与 §12.1（后者的教训：**能用纯函数离线验证的，先在本地测到全绿再打真实服务**）。

---

## 云端生成：只做火山方舟

契约**已用真实 Key 实证**，其中几条推翻了公开资料。

### 视频（Seedance）—— 异步

| 项 | 实测结论 |
| --- | --- |
| 服务端有 `GET /models` | 可直接列出账号可见模型与状态，**不要硬编码模型 id** |
| 公开资料推荐的默认模型 | `doubao-seedance-1-5-pro-251215` **已下线**（`Shutdown`） |
| `duration` | Seedance 2.0 是 **4–15 秒**（1/2/3 与 16 都拒） |
| `service_tier` | **2.0 / 2.0-fast / 2.0-mini 全部不支持**，传了直接报错 |
| 参数支持 | **按「模型 + 模式」分别限定**，不是一套参数通用 |
| 结果 URL | TOS 预签名链接，**24 小时过期**——必须立刻下载落盘 |
| 调用形态 | 提交 → 轮询 → 下载；实测 4 秒片约 **87 秒**完成 |

```powershell
#   video_gen {action: "models"}                    先看有哪些模型（不花钱）
#   video_gen {action: "generate", prompt: "...", duration: 4, resolution: "480p"}
```

### 图像（Seedream）—— 同步

| 项 | 实测结论 |
| --- | --- |
| 端点 | `POST /images/generations`，**同步返回**，没有轮询 |
| 响应 | `data[0] = { url, size: "2496x1664", output_format: "jpeg" }` |
| 尺寸 | 预设字符串（`1k` / `2K`）或 `WxH`；**面积 921,600 – 4,622,220 像素** |
| 越界处理 | **本地先拒**（`512x512` 太小、`8192x8192` 太大），不花钱就暴露错误 |
| 结果 URL | 同样是 **24 小时过期**的 TOS 预签名链接，必须立刻下载 |
| 调用形态 | 同步，实测 2K 图约 **12 秒**，产出 2496×1664 JPEG |
| 模型现状 | `3-0-t2i` 与 `seededit-3-0` 已下线；在售为 `5-0-flash` / `5-0-pro` / `4-0-20260415` |

```powershell
#   video_gen {action: "image_models"}              先看有哪些图像模型（不花钱）
#   video_gen {action: "image", prompt: "...", imageSize: "2k"}
```

命令行同理：`node src/bin/vf.mjs image --prompt "…" --size 2k`

**文件扩展名以服务端报告的格式为准**：调用方写 `cover.png` 而服务端返回 jpeg 时，落地的是 `cover.jpg`。这不是吹毛求疵——下游的 `classify()` 按扩展名判断素材类型，扩展名说谎会让后续步骤走错分支。
