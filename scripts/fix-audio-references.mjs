/**
 * One-shot prose repair after the audio capability moved to `dsh-video-audio`.
 *
 * The structural removal ran first (the tool entries are gone, `TOOL_ORDER` still names them);
 * this script fixes the sentences that referred to them. Each entry is an exact replacement; a
 * pattern that is missing is REPORTED rather than silently skipped, so a re-run on an
 * already-repaired file is a no-op that says so.
 *
 * `node scripts/fix-audio-references.mjs`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {Array<[string, string, string]>} [label, from, to] */
const EDITS = [
  [
    'TOOL_ORDER',
    `  'video_qc',
  'video_audio_build',
  'video_audio_measure',
]`,
    `  'video_qc',
]`,
  ],
  ['guide example', "example: { action: 'tool', tool: 'video_audio_measure' },", "example: { action: 'tool', tool: 'video_inspect' },"],
  [
    'probe summary',
    "'report ffmpeg/ffprobe paths and versions, available encoders and filters, Edge TTS reachability, whether an Ark API key is present, and the state of the audio-event and matting components.',",
    "'report ffmpeg/ffprobe paths and versions, available encoders and filters, Edge TTS reachability, whether an Ark API key is present, and the state of the matting component together with the runtime it borrows from the audio plugin.',",
  ],
  [
    'probe returns',
    "'{ ok, problems[], ffmpeg{path, version, encoders[], filters[]}, ffprobe, vendored, audio{available,...}, matte{...}, arkKeyPresent, ttsReachable } — a missing encoder or filter appears in problems and it names it.',",
    "'{ ok, problems[], ffmpeg{path, version, encoders[], filters[]}, ffprobe, vendored, matte{available, runtime, runtimeDir, runtimeSource, ...}, arkKeyPresent, ttsReachable } — a missing encoder or filter appears in problems and it names it.',",
  ],
  [
    'probe gotcha',
    `'Reading the state of the audio and matte components is file inspection only: it starts no engine and moves nothing.',`,
    `'Reading the state of the matting component is file inspection only: it starts no engine and moves nothing. Sound is not reported here at all — ask audio_setup {action:"status"} in the separate dsh-video-audio plugin.',`,
  ],
  [
    'setup purpose',
    `'Provisioning: fetch the pinned ffmpeg build, the audio-event model and runtime, and the matting model into vendor/. The model installers verify a pinned SHA-256; the ffmpeg installer downloads a release archive and records, but does not enforce, a digest. Removal exists for the two models, not for ffmpeg.',`,
    `'Provisioning: fetch the pinned ffmpeg build and the matting model into vendor/. The model installer verifies a pinned SHA-256; the ffmpeg installer downloads a release archive and records, but does not enforce, a digest. Removal exists for the model, not for ffmpeg. The audio-event model, and the ONNX runtime that both it and matting run on, are installed by the separate dsh-video-audio plugin: audio_setup {action:"install"}.',`,
  ],
  [
    'setup next',
    `      'video_analyze {action:"audio_status"} / {action:"matte_status"} for the models',`,
    `      'video_analyze {action:"matte_status"} for the matting model and the runtime it borrows',`,
  ],
  [
    'matte cost',
    `        cost: '4.36MB; the inference runtime is reused from install_audio and never fetched twice.',`,
    `        cost: '4.36MB; the inference runtime is the one dsh-video-audio installed and is never fetched twice.',`,
  ],
  [
    'matte gotchas',
    `          'Install audio first. The skip test needs both a valid model and a working runtime, so when only the runtime is missing this still downloads the 4.36MB model and then tells you to run install_audio — the download was wasted.',
          'remove deletes the model only and keeps the shared runtime, so matte can be removed without breaking audio event detection.',`,
    `          'The runtime is a hard prerequisite and part of the skip test: with no runtime this refuses before downloading, naming audio_setup {action:"install"} in the sibling plugin, rather than spending 4.36MB on a model that could not load.',
          'remove deletes the model only and leaves the shared runtime alone, so matting can be removed without touching audio event detection.',`,
  ],
  ['matte seeAlso', `        seeAlso: ['install_audio', 'video_analyze'],`, `        seeAlso: ['video_analyze'],`],
  [
    'qc boundary',
    `'A silent stretch, a bad take or weak material is not visible here; that is video_qc and video_audio_measure territory.',`,
    `'A silent stretch, a bad take or weak material is not visible on the picture; that is video_qc territory, and for the sound itself it is audio_measure in the separate dsh-video-audio plugin.',`,
  ],
  [
    'inspect seeAlso',
    `        seeAlso: ['video_env', 'video_audio_measure'],`,
    `        seeAlso: ['video_env', 'video_analyze'],`,
  ],
  [
    'analyze needs',
    `      'the YAMNet model and runtime (video_setup {action:"install_audio"}) for audio_events',`,
    `      'the shared ONNX runtime for matte, which audio_setup {action:"install"} in the separate dsh-video-audio plugin provides',`,
  ],
  [
    'playbook model installs',
    `'Needs a one-time model install (video_setup): audio_events and matte (install_audio, about 28MB) and matte also install_matte (4.36MB, reuses that runtime); ffmpeg needs install_ffmpeg (a few hundred MB). Reading text off a picture needs the separate dsh-ocr plugin (text_setup {action:"install"}).',`,
    `'Needs a one-time model install: matte needs video_setup {action:"install_matte"} (4.36MB) and needs the shared ONNX runtime that audio_setup {action:"install"} in the separate dsh-video-audio plugin provides (about 28MB); ffmpeg needs video_setup {action:"install_ffmpeg"} (a few hundred MB). Reading text off a picture needs the separate dsh-ocr plugin (text_setup {action:"install"}), and classifying a soundtrack needs audio_measure {action:"audio_events"} in dsh-video-audio.',`,
  ],
  [
    'playbook audio event symptom',
    `'Music starts at the wrong moment, or a stretch is silent → video_analyze {action:"audio_events"} (transcription cannot show this).',`,
    `'Music starts at the wrong moment, or a stretch is silent → audio_measure {action:"audio_events"} in the separate dsh-video-audio plugin (transcription cannot show this).',`,
  ],
  [
    'playbook model status',
    `'video_env {action:"probe"} again, then the status actions: video_analyze {action:"audio_status"} and {action:"matte_status"}.',`,
    `'video_env {action:"probe"} again, then video_analyze {action:"matte_status"} for the matte side; sound and its model belong to dsh-video-audio, whose audio_setup {action:"status"} reports them.',`,
  ],
  [
    'playbook matte prerequisite',
    `'video_setup {action:"install_audio"} before {action:"install_matte"}: the matting model reuses the runtime audio installs, and installing matte first downloads the model for nothing.',`,
    `'audio_setup {action:"install"} (dsh-video-audio) before video_setup {action:"install_matte"}: the matting model reuses the runtime the audio plugin installs, and install_matte now refuses before downloading when it is absent.',`,
  ],
  [
    'playbook model installs note',
    `'Locally inferred but hardware-dependent: video_analyze {action:"audio_events"} and {action:"matte"} run a model on this machine; their timings vary, their outputs do not (fixed seeds and fixed resolution).',`,
    `'Locally inferred but hardware-dependent: video_analyze {action:"matte"}, and audio_measure {action:"audio_events"} in the sibling plugin, run a model on this machine; their timings vary, their outputs do not (fixed seeds and fixed resolution).',`,
  ],
  ['sample_frames seeAlso', `        seeAlso: ['audio_events', 'video_plan'],`, `        seeAlso: ['matte_status', 'video_plan'],`],
  [
    'analyze runtime note',
    `      'Runtime and model are reported separately because they install separately: install_audio provides the runtime that install_matte reuses.',`,
    `      'Runtime and model are reported separately because they are installed by different plugins: the runtime comes from audio_setup {action:"install"} in dsh-video-audio, the model from video_setup {action:"install_matte"} here. runtimeSource says which directory answered.',`,
  ],
  [
    'qc cost',
    `        cost: 'the heaviest read-only action here: structure is two ffprobes, audio is roughly four decode passes, picture decodes the whole film once as greyscale.',`,
    `        cost: 'the heaviest read-only action here: structure is two ffprobes, picture decodes the whole film once as greyscale.',`,
  ],
]

/** Renames applied everywhere afterwards, including inside arrays. */
const RENAMES = [
  ['video_audio_build', 'audio_build'],
  ['video_audio_measure', 'audio_measure'],
]

const files = ['src/tools/registry.mjs', 'src/tools/playbook.mjs', 'src/tools/guide.mjs', 'src/tools/env.mjs']
let touched = 0
for (const relative of files) {
  const path = resolve(ROOT, relative)
  let body = readFileSync(path, 'utf8')
  const applied = []
  const missing = []
  for (const [label, from, to] of EDITS) {
    if (!body.includes(from)) {
      missing.push(label)
      continue
    }
    body = body.split(from).join(to)
    applied.push(label)
  }
  for (const [from, to] of RENAMES) {
    const hits = body.split(from).length - 1
    if (hits > 0) {
      body = body.split(from).join(to)
      applied.push(`${hits}× ${from} → ${to}`)
    }
  }
  writeFileSync(path, body, 'utf8')
  touched += applied.length
  console.log(`\n${relative}`)
  for (const label of applied) console.log(`  已改：${label}`)
  for (const label of missing) console.log(`  未命中（可能已改过或本来就不同）：${label}`)
}
console.log(`\n共 ${touched} 处。`)
