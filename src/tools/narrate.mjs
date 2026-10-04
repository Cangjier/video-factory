/**
 * `video_narrate` — text to speech and subtitles.
 *
 * Synthesis and cue-building are deliberately separate actions. Synthesis needs the
 * network and costs time; splitting words into cues is pure computation that can be
 * re-run with different line lengths for free. Binding them together (as the old
 * `narrate` command did) forces a re-synthesis for every subtitle tweak.
 *
 * @module video-factory/tools/narrate
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const NARRATE_TOOL_NAME = 'video_narrate'

export function createNarrateTool(actions, locate) {
  return defineFamilyTool({
    name: NARRATE_TOOL_NAME,
    locate,
    actions: ['synthesize', 'to_cues', 'srt_write', 'srt_read', 'layout', 'transcribe'],
    extraProperties: {
      text: { type: 'string', description: 'synthesize: narration text inline. Give either text or textPath.' },
      textPath: { type: 'string', description: 'synthesize: read the narration text from this UTF-8 file instead.' },
      outDir: { type: 'string', description: 'synthesize: directory for voiceover.mp3 and voiceover.words.json.' },
      voice: { type: 'string', description: 'synthesize: Edge TTS voice short name. Defaults to the configured voice (zh-CN-XiaoxiaoNeural).' },
      rate: { type: 'string', description: 'synthesize: rate adjustment such as "+10%" or "-15%".' },
      pitch: { type: 'string', description: 'synthesize: pitch adjustment such as "-2Hz".' },
      volume: { type: 'string', description: 'synthesize: volume adjustment such as "+0%".' },
      audioPath: {
        type: 'string',
        description:
          'transcribe: the media file to transcribe, video or audio. Its audio track is extracted automatically and converted to the 16 kHz mono WAV the recogniser requires.',
      },
      language: {
        type: 'string',
        enum: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
        description:
          'transcribe: language hint. Defaults to "auto". Naming the language improves accuracy; the local model covers Chinese, English, Cantonese, Japanese, and Korean.',
      },
      maxAudioSeconds: {
        type: 'integer',
        description:
          'transcribe: keep each recogniser request under this many seconds. Defaults to 120, which stays inside the host\'s 4 MB per-request limit. Longer material is cut at detected pauses so a word is not split.',
      },
      wordsPath: { type: 'string', description: 'to_cues: word-timing JSON to read. Defaults to the last synthesize output.' },
      maxChars: { type: 'integer', description: 'to_cues / layout: maximum characters per subtitle line. Defaults to 18.' },
      cuesPath: { type: 'string', description: 'srt_write: cue JSON to serialize. Defaults to the last to_cues output.' },
      srtPath: { type: 'string', description: 'srt_write: destination .srt. srt_read: source .srt.' },
      scale: { type: 'number', description: 'layout: multiply every cue timestamp by this factor to align subtitles with a re-timed picture.' },
      canvasWidth: { type: 'integer', description: 'layout: canvas width in pixels, used to scale font size. Defaults to 1080.' },
      canvasHeight: { type: 'integer', description: 'layout: canvas height in pixels. Defaults to 1920.' },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
