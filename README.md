# video-factory

**素材进，成片出。** 一个 DeepSeek Harness 插件：把图片、视频片段、音乐和一段文案，变成一条能直接发布的 mp4。

```
DSH 决定做什么  →  video_* 工具确定性地执行
```

**插件只提供确定性工具，流程与创作决策全部归 DSH。** 没有"一键出片"命令，因为镜头顺序、节奏、时长、选哪张图——这些都是创作判断，不该由工具替你决定。

- 工具清单、契约、设计取舍：[docs/插件设计规格.md](docs/插件设计规格.md)

---

## 工具

插件注册 7 个工具，共 33 个 action。每个工具的 schema 每轮都会进入模型上下文，所以按操作族分组、族内用 `action` 分派，而不是摊成三十多个独立工具。

| 工具 | action | 做什么 |
| --- | --- | --- |
| `video_env` | `probe` `presets` `scan` `install_ffmpeg` `install_ocr` `install_audio` | 环境自检、画布预设、素材盘点、装 ffmpeg、装离线 OCR 引擎、装音频事件模型 |
| `video_narrate` | `synthesize` `to_cues` `srt_write` `srt_read` `layout` `transcribe` | 文案→配音+逐词时间戳；断句；SRT 读写；字幕排版；**语音转文字** |
| `video_plan` | `check` `duration` `fields` `diagnose` | 计划校验、精确时长、字段速查、客观问题诊断 |
| `video_render` | `scene` `assemble` `finalize` `deliver` `build` | 单镜头、拼接、合成、交付、整链 |
| `video_inspect` | `verify` `media` `ocr` `find_text` `ocr_status` | 成片验收、媒体元信息、**读图取字（带坐标）**、**定位文字** |
| `video_gen` | `models` `generate` `image_models` `image` | 方舟模型发现；**文生视频**；**文生图** |
| `video_analyze` | `sample_frames` `audio_events` `audio_status` | **自适应抽帧**（找剪切点与运动）、**音频事件识别**（音乐/环境音/音效） |

**先说清楚边界**：`scan` 只盘点不取舍（重复图**标注**而非删除）；`check` 只判断不修改；`diagnose` 只报客观事实（"静止图没给 motion"），不报品味（"这个镜头该放前面"）；`sample_frames` 报"哪一帧动了、动了多少"和选中它的理由，不报"这个运镜好不好"；`audio_events` 报"这一段是什么声音"，不报"配乐合不合适"。`video_gen` 是**唯一不满足"同输入同输出"**的工具——同 prompt 不同结果，它是执行器不是确定性算子。

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

### 离线 OCR（可选，但强烈建议装）

`video_inspect {action:"ocr"}` 读图片/视频帧里的文字，每行都带**像素框**和置信度；`find_text` 反过来，
给一段文字，返回它在图上的**中心点**（可直接点）。两个场景一套代码：读数据、找控件。

不装引擎也能用——退回 Windows 自带的 `Windows.Media.Ocr`，**零安装但读不准小字**：
实测它把 `TypeScript` 读成 `TvpeScript`、`自动化任务` 读成 `自 动 化 亻 壬 务`。装上引擎后同样一张图读对。

```
video_env {action: "install_ocr", prune: true}          # 装默认引擎（RapidOCR/PP-OCRv4，MIT）
video_env {action: "install_ocr"}                        # 用安装时的缓存包
```

| 项 | 说明 |
| --- | --- |
| 引擎 | `rapidocr-json`（默认）：ONNX Runtime + PP-OCRv4 简中，**MIT**，不要求 AVX。解包约 95 MB，`prune: true` 后约 44 MB |
| 备选 | `paddleocr-ppocrv5`：第三方 Paddle Inference 构建 + PP-OCRv5，个别小字更准，但**同一张图实测慢约 9 倍**（15.9 s vs 1.77 s），且要求 AVX |
| 实测速度 | 整屏 1200x1013：约 1.8–2.2 s / 35 行；**只截一小块再放大：约 0.2 s**。所以找控件时给 `region` |
| 小字技巧 | `scale: "auto"` 会把小图（或小 `region` 裁片）放大到长边约 1000px——11px 的字不放大基本读不出 |
| 校验 | 包按 **sha256 硬校验**后才解包；引擎以常驻子进程运行，空闲 120 s 自动退出，释放约 500 MB |
| 网络慢 | `install_ocr {archive: "D:/下载/xxx.7z"}` 用本地包（sha256 照样校验）。实测 GitHub CDN 会把这次下载限到约 20 KB/s |
| 云端 | **不做**。视觉模型给不出逐行文字的像素框；要"看懂画面"请让 DSH 自己看图 |

命令行：`node src/bin/vf.mjs install-ocr --prune`；读图：`node src/bin/vf.mjs ocr <图片> --region 600,100,620,56 --scale auto --find "始终安装"`。

设计与实测数据见 [docs/插件设计规格.md](docs/插件设计规格.md) §13。

### 云端生成（可选）

只有火山方舟一家。需要环境变量 `ARK_API_KEY`——**且必须让 DSH 进程能看到它**（设成系统环境变量后重启 DSH）。没有 Key 时**只有 AI 生成不可用**，本地剪辑、配音、字幕全部照常。

商用前注意两点：**Edge TTS 的商用授权不明确**，商用一律换 CosyVoice / Azure；**AI 生成内容有标识义务**，公开发布前加显式水印。

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

## 音频事件检测（可选，强烈建议装）

**转录解决"说了什么话"，这一项解决"这是什么声音"**——是背景音乐、是环境噪音、还是静音。剪片子卡点要用的是后者，而它以前完全读不出来。

```
video_env {action: "install_audio"}        # 装 YAMNet + WASM 运行时，约 28 MB
video_analyze {action: "audio_events", target: "out/final.mp4"}
```

输出是**逐窗的标签 + 时间点**，时间点可直接用于剪辑：

```
18.50s，37 个分析窗（分类 37，静音 0）
  Music        32 次  1.92, 2.4, 2.88, 3.36, 3.84, 4.32, 4.8, 5.76 …
  Chirp tone    3 次  0.48, 0.96, 1.44
  Sine wave     5 次  0.48, 0.96, 1.44, 1.92, 2.88
```

| 项 | 说明 |
| --- | --- |
| 模型 | **YAMNet**（AudioSet **521 类**，ONNX）。与参考项目用的 PANNs 同一套本体，标签语义可直接对比 |
| 运行时 | **WASM**，不装 Python、不要 GPU、无原生库 |
| 体积 | 模型 15.39 MB + 运行时 13.01 MB = **28.40 MB**（比 OCR 引擎的 44.7 MB 还小） |
| 速度 | 单窗实测 **68–81 ms**；窗长 0.96 s、跳步 0.48 s，**每步有 480 ms 预算**，用掉不到两成 |
| 几何 | 16 kHz 单声道；窗口 15360 采样、跳步 7680 |
| 静音 | RMS 低于 `silenceRms`（默认 0.002）的窗报 `silent: true`，**不强行贴标签** |
| 校验 | 模型按 **sha256**、运行时按 npm **sha512 integrity** 硬校验后才落盘；`install_audio` 幂等，已装且校验通过则跳过 |
| 网络 | 自动走系统代理（见"踩过的坑"）。如果托管方完全不可达：`install_audio {archive:"D:/模型"}` 指向一个含 `yamnet.onnx` + `yamnet_class_map.csv` 的目录，或直接指向 `.onnx` 文件——**sha256 照样硬校验** |
| 失败安全 | 模型先落到临时目录、校验通过才移入。下载中断**不会**破坏已装好的树（实测：两次 `fetch failed` 后 128/128 校验仍全绿） |
| 删除 | `video_env {action:"install_audio", remove: true}` |
| 不做 | **不建议商用前跳过来源核对**。模型来源链见下 |

**为什么不用原生 `onnxruntime-node`**：它解包 **245.7 MB**（三平台 × 两架构的原生库），并且会打破本插件"纯 ESM、无依赖边"的性质。实测两条路径在同一个窗上**分数一致到小数点后六位**（0.977061 vs 0.977062），所以选了小的。

**来源必须如实说**：权重经过两次个人转存，没有官方发布哈希。

```
Google YAMNet（Apache-2.0，TF-Hub）
  → jafet21/yamnetonnx → niobures/YAMNet → vendor/audio/yamnet/yamnet.onnx
```

清单里记录的 sha256 是**首次落盘时的完整性锚点**，用于防篡改与复现，**不构成来源合法性证明**。完整溯源写在 `vendor/audio/SOURCE.json`。

---

## 自适应抽帧

均匀抽帧会把预算浪费在静止镜头上，又漏掉真正的那一刀。`sample_frames` 解码一份灰度代理流，逐帧与前一帧做**平均绝对亮度差**，让剪切点和运动自己冒出来：

```
video_analyze {action: "sample_frames", target: "out/final.mp4", extract: true}
```

**每一帧都带选中理由**，这是它区别于"给我 N 帧"的地方：

| reason | 含义 |
| --- | --- |
| `first_frame` | 第一帧永远选中，保证不会抽成空 |
| `scene_change` | 场景分 ≥ `sceneThreshold`（默认 30）→ 硬切 |
| `motion` | 运动分 ≥ `motionThreshold`（默认 5） |
| `periodic` | 分不够但到了 `targetFps` 的节奏（默认 1 fps） |
| `max_interval_fallback` | 长期静止的兜底，`minFps` 决定（默认 0.25 fps） |

实测在一条 4 段纯色合成视频上，三处剪切点全部命中，分数 46.0 / 46.0 / 64.9。

`extract: true` 会把选中的帧写成 JPEG，**直接交给 `read_image` 看**——分值负责"哪里要紧"，眼睛负责"画面好不好"。两者不是替代关系。

**分值只在同一探测几何下可比**：它是 0–255 的平均绝对亮度差，改 `probeFps` 或探测分辨率就会变。每次返回都会回显实际用的几何与阈值。

---

## 纯色背景替换（绿幕）

**不需要任何模型。** 纯色背板直接走 ffmpeg `colorkey`，开销基本只有解码。只有背景**不是**纯色时，才需要 `video_analyze {action:"matte"}` 那条学习式路径。

```jsonc
{
  "id": "s01", "kind": "image", "source": "material/主持人口播.jpg",
  "chroma_key": {
    "color": "#00B140",      // 要抠掉的颜色
    "similarity": 0.3,       // 越大抠得越狠
    "blend": 0.1,            // 边缘过渡
    "background": "#102040", // 替换背景（目前仅纯色）
    "spill": true            // 去溢色：绿幕反光留在主体边缘的绿边
  }
}
```

**必须给 `background`**，否则看不出效果：抠像产生的是 alpha，而镜头最后会转成 `yuv420p`，alpha 在那一步被丢弃。没有背景可合成时，滤镜等于没生效。

去溢色的通道由 `color` **自动推断**（绿幕去绿、蓝幕去蓝），所以不会出现"绿幕配蓝色去溢色"这种错配。

实测（1920×1080，30 fps）：绿幕完全消失，主体完整保留，背景正确铺上。

| 限制 | 说明 |
| --- | --- |
| 与 `overlays[]` 不能同时用 | 合成会把滤镜图拆成多段并引入第二个输入，文字叠加需要另接一段。组合使用**直接报错**，而不是产出一张时序错误的图 |
| 背景仅支持纯色 | 图片/视频背景需要第二个输入，尚未实现 |

**默认值偏保守**，这是刻意的：`similarity` 是 RGB 距离，有用值取决于布光、溢色和压缩。我拿合成板标定过，发现**一大段取值都能完美分离**——也就是说合成板根本选不出正确值，只有真实素材能。所以默认宁可多留一点，也不要把主体吃掉，并把实际生效的数值回报出来供你对着真实帧调。

---

## DSH 能"看懂"一条视频吗？

能看画面，也能识别声音类别了。但有几件事仍然做不到，分开说清楚：

| 能力 | 状态 |
| --- | --- |
| 看单张图 | ✅ 模型原生支持（`read_image`） |
| 找"哪一刻值得看" | ✅ `video_analyze {action:"sample_frames"}` —— 剪切点与运动自动选中，带理由与分值 |
| 抽帧落盘再逐张看图 | ✅ `sample_frames {extract:true}` 写出 JPEG，路径直接可读 |
| 语音转文字 | ✅ 启用语音 bundle 后，`video_narrate {action:"transcribe"}` |
| 识别音乐 / 环境音 / 音效 | ✅ `video_analyze {action:"audio_events"}`（需先 `install_audio`） |
| 逐帧扫全片的**画面含义** | ⚠️ 可行但慢、费上下文；关键帧已能自动筛，但每张图仍要进上下文 |
| 判断**响度**是否合规 | ⚠️ 渲染链用 EBU R128 归一，但**读不出"这段响不响"**的感知判断 |
| **判断运镜舒不舒服** | ❌ **本质限制**：差值法能给出"哪里在动、动得多剧烈"，给不出"这个推拉好不好看" |
| 判断**卡点准不准** | ⚠️ 已有两项输入（音频事件的时间点 + 画面运动的时间点），但"准不准"的结论仍需你下 |

最后两条是本质限制，不是没实现：可以确认"这一帧画面对不对""这一段是什么声音"，但**审美判断仍需人的眼睛和耳朵**。

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
node src/bin/vf.mjs install-ocr --prune                            # 装离线 OCR 引擎
node src/bin/vf.mjs ocr 截图.png --region 600,100,620,56 --scale auto --find "始终安装"
node src/bin/vf.mjs install-audio                                  # 装音频事件模型 + WASM 运行时
node src/bin/vf.mjs frames out/final.mp4 --probe-fps 6             # 自适应抽帧
node src/bin/vf.mjs audio out/final.mp4 --top-k 2 --min-score 0.2   # 音频事件识别
```

## 端到端验证

```powershell
node --test "tests/*.test.mjs"                                    # 189 个离线用例
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
vendor/ocr/            离线 OCR 引擎（可选；装之前 OCR 走 Windows 自带识别）
vendor/audio/          YAMNet 模型 + WASM 推理运行时（可选；装之前 audio_events 不可用）
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
| Windows 没有能解 `.7z` 的工具 | `tar.exe` 报 `LZMA codec is unsupported`，7-Zip 通常没装 | 安装器顺带取官方 `7zr.exe`（0.6 MB）放进 `vendor/ocr/tools/` |
| OCR 坐标乘错方向 | 放大图的框要**除以**倍数、**再加**裁剪偏移；反了就是平方级偏移，点击落到别处 | 在一处换算、单测覆盖旋转框与偏移+缩放组合 |
| 常驻 OCR 引擎拖住进程 | 短命脚本会等空闲计时器（120 s）才退出 | 插件卸载时 `disposeOcrSessions()`，测试与 CLI 显式释放 |
| **系统代理对 Node 不可见** | `install_*` 从插件里报 `fetch failed`，但同一个 URL 在 PowerShell 里 **1.4 秒就取到**。Node 的 `fetch` 既不读 Windows 注册表代理，也不认 `HTTPS_PROXY`（Node 24 实测：设了变量、加了 `NODE_USE_ENV_PROXY=1`，仍然直连超时）。而 `Invoke-WebRequest`、浏览器、其它 Windows 程序都走注册表代理 | 自己读注册表 `ProxyEnable`/`ProxyServer`，用 `http CONNECT` + `tls` 建隧道；`undici` 在 Node 24 里**不可导入**，所以只能用内置模块手写 |
| 代理下漏掉重定向 | HF 的 `/resolve/` 返回 **307/302** 跳 CDN。第一版 `httpFetch` 不跟重定向，于是把 278 字节的 "Temporary Redirect" 页面当成模型下载并去校验哈希 | 跟随重定向（上限 8 跳），并在每跳后排空响应体 |
| **静音时间线让 `loudnorm` 产出 NaN** | 没有配音也没有音乐的 plan 在最后一步失败：`[aac] Input contains (near) NaN/+-Inf`。报错只说编码器，**完全没提响度**，靠逐段二分才定位到 `loudnorm`。此前**任何空音频块的 plan 都渲染不出成片** | 静音源跳过 `loudnorm`（静音没有响度可归一），只固定编码器要的采样格式。回归测试 `tests/finalize.test.mjs`（已回退验证过它真的会失败） |
| **`lavfi` 源默认无限长** | 抠像背景输入不加 `-t` 时 `overlay` 无休止产帧；画面被输出 `-t` 截住而音频耗尽，又死在 AAC 编码器上，报的还是 NaN | 背景输入按镜头时长加 `-t` |
| **`-v error` 把测量一起静音** | `signalstats` / `metadata=print` 走日志系统，`-v error` 下 `spawnSync` 拿回空字符串，看起来像"没有数据" | 需要测量时用 `-v info` |

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
