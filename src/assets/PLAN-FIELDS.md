# 剪辑计划字段速查（plan.json）

一份 plan.json 描述成片的全部内容。**DSH 负责决定内容，video-factory 负责确定性地执行。**
同一份计划永远渲染出同样的结果。

## 根

| 字段 | 说明 |
| --- | --- |
| `version` | 固定 1 |
| `meta` | 画布与质量 |
| `audio` | 音轨 |
| `subtitles` | 字幕 |
| `scenes[]` | 镜头列表，至少一个 |

## meta

| 字段 | 取值 | 默认 |
| --- | --- | --- |
| `title` | 成片标题 | `""` |
| `preset` | `vertical-short`(1080x1920) / `horizontal`(1920x1080) / `square`(1080x1080) / `landscape-4k`(3840x2160) / `preview`(640x360) | `custom` |
| `width` / `height` | 64–7680，覆盖 preset | preset 值 |
| `fps` | 1–120 | preset 值（多为 30） |
| `quality` | `high`(crf18) / `medium`(crf21) / `draft`(crf27) | `high` |

## audio

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `voiceover` | 配音音轨路径（相对 plan.json） | null |
| `music` | 背景音乐路径 | null |
| `music_gain_db` | 音乐相对增益，-60..12 | -18 |
| `duck` | 说话时自动压低音乐（sidechaincompress） | true |
| `duck_amount` | 闪避量，0..1 | 0.18 |
| `fade_in` / `fade_out` | 音乐淡入淡出秒数，0..60 | 0 / 1.5 |
| `loudness_target` | EBU R128 目标响度 LUFS，-40..-5 | -14 |
| `keep_scene_audio` | 有配音时是否保留视频素材自带声音 | true |

## subtitles

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `enabled` | 是否启用字幕 | false |
| `source` | `.srt`/`.ass` 路径；`auto` 表示由配音自动生成 | null |
| `burn` | true=烧录进画面，false=软字幕轨 | true |
| `font_size` | 8–200（按 1080 宽缩放） | 44 |
| `margin_v` | 距底边像素，0..2000 | 200 |
| `primary_color` / `outline_color` | `#RRGGBB` | #FFFFFF / #000000 |
| `outline` | 描边宽度，0..20 | 3 |
| `bold` | 粗体 | false |
| `max_chars_per_line` | 4..80 | 18 |

## scenes[]（核心）

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `id` | 唯一标识，缺省按顺序 `s01`,`s02`… | 自动 |
| `kind` | `image` / `video` / `color` / `generated` | 有 `generate` 则 `generated`，否则 `video` |
| `source` | 素材路径，相对 plan.json | — |
| `color` | `kind=color` 时的 `#RRGGBB` | #000000 |
| `duration` | 该镜头在时间轴上占用的秒数，0.2–600 | 3 |
| `motion` | 静止图运动：`none`/`kenburns`/`zoom-in`/`zoom-out`/`pan-left`/`pan-right` | none |
| `fit` | `cover`(裁切填满) / `contain`(留黑边) / `blur-pad`(模糊填充) | cover |
| `start` | 视频素材从第几秒开始取，≥0 | 0 |
| `speed` | 变速倍数，0.1–10（音频同步变速不变调） | 1 |
| `volume` | 该镜头音量，0–4 | 1 |
| `muted` | 静音该镜头 | false |
| `transition` | 进入该镜头的转场 `{type, duration}`，duration 0–5 | `{none, 0.5}` |
| `overlays[]` | 画面文字，见下 | [] |
| `generate` | 云端生成该镜头，见下 | null |
| `note` | 备注，不参与渲染 | "" |

### transition.type 可选值

`none` `fade` `fadeblack` `fadewhite` `wipeleft` `wiperight`
`slideleft` `slideright` `smoothleft` `circleopen` `dissolve`

**有效重叠 = min(转场时长, 本镜时长×0.5, 上一镜时长×0.5)** —— 所以短镜头不会被自己的转场吃掉。
时间轴总时长 = Σ镜头时长 − Σ有效重叠。

## overlays[]

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `text` | 文字内容，支持换行。**内部走 `textfile=`，绝不内联进滤镜串** | 必填 |
| `anchor` | 九宫格：`top-left` `top-center` `top-right` `center-left` `center` `center-right` `bottom-left` `bottom-center` `bottom-right` | bottom-center |
| `font_size` | 8–400，按画布宽度相对 1080 缩放 | 48 |
| `color` | `#RRGGBB` | #FFFFFF |
| `box` | 文字后画半透明底框 | true |
| `margin` | 距锚定边像素，0..2000 | 80 |
| `start` / `end` | 在该镜头内的出现/消失秒数；end 为 null 表示持续到镜头结束 | 0 / null |

## generate

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `provider` | 固定 `ark`（字节跳动火山方舟） | ark |
| `mode` | `text-to-video` / `image-to-video` / `first-last-frame` | text-to-video |
| `prompt` | 画面描述 | 必填 |
| `reference` | 首帧图片（本地路径或公网 URL） | null |
| `last_frame` | 尾帧图片，配合 `first-last-frame` | null |
| `duration` | 1–60。**实际合法范围按模型不同**：Seedance 2.0 是 4–15 | 5 |
| `resolution` | `480p` / `720p` / `1080p` / `4k` | 720p |
| `ratio` | `16:9` `9:16` `1:1` `4:3` `3:4` `21:9` `adaptive` | null（用服务端默认） |
| `model` | 覆盖默认模型 id。**先用 video_gen 的 models 动作确认模型可用** | null |
| `seed` | -1 为随机；固定值可近似复现 | -1 |
| `watermark` | 保留厂商水印（同时也满足 AI 内容标识义务） | true |
| `service_tier` | 离线档位如 `flex`。**Seedance 2.0 不支持，传了会直接报错** | null |
