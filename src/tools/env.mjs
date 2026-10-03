/**
 * `video_env` — environment self-check, canvas presets, material inventory, provisioning.
 *
 * The actions answer "can I work here at all?", "what shapes can I produce?",
 * "what raw material do I have?", and "can this machine read text off a picture?".
 * None of them decide anything: `scan` reports duplicates as facts and never drops
 * them, because which still to use is a creative choice that belongs to DSH.
 *
 * @module video-factory/tools/env
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const ENV_TOOL_NAME = 'video_env'

/** Installable OCR sources, mirrored from the core installer so the enum cannot drift. */
const OCR_SOURCE_IDS = ['rapidocr-json', 'paddleocr-ppocrv5']

export function createEnvTool(actions) {
  return defineFamilyTool({
    name: ENV_TOOL_NAME,
    description:
      'video-factory environment and material inventory. Use it before any other video_* tool to confirm ffmpeg is available, and to turn a material folder into a structured list before deciding what the video should contain.',
    actionsHelp:
      'probe: report ffmpeg/ffprobe paths and versions, available encoders and filters, Edge TTS reachability, whether an Ark API key is present, and which input transports this machine can actually use (a virtual HID keyboard, the Interception filter driver, or Win32 SendInput). ' +
      'presets: list the canvas presets (vertical-short, horizontal, square, landscape-4k, preview). ' +
      'scan: inventory a material folder — every image, video, and audio file with its probe metadata, near-duplicate stills marked (not removed), and unsupported files skipped. ' +
      'This never picks, ranks, or drops material; choosing is yours. ' +
      'install_ffmpeg: download a pinned ffmpeg static build into vendor/ when "probe" reports it missing. Needs the network and a few hundred megabytes. ' +
      'install_ocr: download and unpack a pinned offline OCR engine into vendor/ocr/ so video_inspect {action:"ocr"} can read text accurately; without it those actions fall back to the Windows recogniser, which misreads small mixed-script text. Also removes an installation when "remove" is true. ' +
      'install_audio: download the pinned YAMNet model (AudioSet 521 classes) and the WASM inference runtime into vendor/audio/ so video_analyze {action:"audio_events"} can identify music, ambience, and sound effects. About 28MB, no Python and no GPU. Also removes the installation when "remove" is true. ' +
      'install_matte: download the pinned 4.36MB U²-Net model into vendor/matte/ so video_analyze {action:"matte"} can cut a subject out of a backdrop that is not a flat colour. Reuses the inference runtime install_audio provides, so a second copy is never fetched. Also removes the model when "remove" is true.',
    actions: ['probe', 'presets', 'scan', 'install_ffmpeg', 'install_ocr', 'install_audio', 'install_matte'],
    extraProperties: {
      root: { type: 'string', description: 'Material folder to inventory. Required for "scan".' },
      recursive: { type: 'boolean', description: 'scan: descend into subdirectories. Defaults to true.' },
      dedupe: {
        type: 'boolean',
        description:
          'scan: compute perceptual hashes and mark near-duplicate stills. Defaults to true. Duplicates are reported via "duplicateOf", never removed.',
      },
      force: {
        type: 'boolean',
        description: 'install_ffmpeg / install_ocr / install_audio: reinstall even when a copy is already present.',
      },
      source: {
        type: 'string',
        enum: OCR_SOURCE_IDS,
        description:
          'install_ocr: which engine package to install. "rapidocr-json" (default) is ONNX Runtime with PP-OCRv4 and reads a 1200x1013 screenshot in about 1.8s here; "paddleocr-ppocrv5" is a third-party Paddle Inference build with the newer PP-OCRv5 models, slightly more accurate on some small text and about nine times slower on the same image.',
      },
      prune: {
        type: 'boolean',
        description:
          'install_ocr: delete recognition libraries for languages this plugin never asks for. Saves roughly 50MB.',
      },
      archive: {
        type: 'string',
        description:
          'install_ocr / install_audio / install_matte: use a local package instead of downloading it. For ocr that is the engine .7z, for audio the YAMNet .onnx, for matte the U²-Net .onnx. Use this when the host serving the file is slow or blocked — the file arrives by whatever means and its SHA-256 is still checked against the pinned one.',
      },
      remove: {
        type: 'boolean',
        description: 'install_ocr / install_audio: remove the installation instead of installing it.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
