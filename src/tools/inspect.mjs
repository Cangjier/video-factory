/**
 * `video_inspect` — quality control, media facts, and reading text off a picture.
 *
 * `verify` is the check that decides whether a delivery is clean: an empty
 * `problems` array means the finished file matches the plan. Anything non-empty
 * must be translated to the user rather than hidden, which is why the render tool
 * description points here.
 *
 * `ocr` and `find_text` are here rather than in a family of their own because they answer the
 * same kind of question as `media` — what is actually in this file — and because a separate
 * tool would cost every turn a second schema for something used occasionally.
 *
 * @module video-factory/tools/inspect
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const INSPECT_TOOL_NAME = 'video_inspect'

/** Actions every `find_text` call may use when matching. */
const MATCH_MODES = ['contains', 'exact']

/** How an OCR call chooses an engine. */
const OCR_ENGINES = ['auto', 'local', 'winrt']

export function createInspectTool(actions) {
  return defineFamilyTool({
    name: INSPECT_TOOL_NAME,
    description:
      'Inspect media and check a finished video against its plan. Use "verify" as the last step of every delivery: an empty problems array is the only clean result.',
    actionsHelp:
      'verify: compare a rendered file with its plan — resolution, frame rate, duration within tolerance, presence of an audio track, pixel format, and a minimum size. Returns {ok, problems}. ' +
      'media: stream metadata for any image, video, or audio file, several at once if you like. ' +
      'ocr: read text off an image, or off frames of a video, returning every line with its pixel box, its score, and the joined text. ' +
      'find_text: locate one or more strings in an image (or a video frame) and return each match with its pixel box and centre point — this is how a label on screen becomes a click coordinate. ' +
      'ocr_status: report which OCR engine is installed and what it can do, without reading anything.',
    actions: ['verify', 'media', 'ocr', 'find_text', 'ocr_status'],
    extraProperties: {
      plan: { type: 'string', description: 'verify: path to the plan the file was rendered from.' },
      planData: { type: 'object', additionalProperties: true, description: 'verify: an inline plan document.' },
      target: {
        type: 'string',
        description:
          'verify / media: the file to inspect, typically out/final.mp4. ocr / find_text: the image or video to read.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'media: several files to probe in one call. ocr: up to 12 images to read in one call.',
      },
      needle: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description: 'find_text: the text to look for, or several strings at once. Case and spacing are ignored.',
      },
      match: {
        type: 'string',
        enum: MATCH_MODES,
        description:
          'find_text: "contains" (default) matches a line that contains the needle; "exact" requires the whole line to equal it.',
      },
      region: {
        type: ['string', 'object'],
        additionalProperties: true,
        description:
          'ocr / find_text: read only this part of the image, as {x,y,width,height} or "x,y,width,height". ' +
          'A small region is both faster and more accurate than a whole screen: 11px text that is unreadable at full size becomes readable once cropped and enlarged.',
      },
      scale: {
        type: ['number', 'string'],
        description:
          'ocr / find_text: enlarge before recognising. "auto" (recommended with region) grows a small crop until its long side is about 1000px, at most 3x. A number is used as-is.',
      },
      engine: {
        type: 'string',
        enum: OCR_ENGINES,
        description:
          'ocr / find_text: "auto" (default) uses the installed offline engine and falls back to Windows OCR; "local" requires the offline engine; "winrt" uses Windows OCR only, which is faster but misreads small mixed-script text.',
      },
      language: {
        type: 'string',
        description: 'ocr / find_text: recognition language for the offline engine. Defaults to "ch" (Simplified Chinese).',
      },
      maxSideLen: {
        type: 'number',
        description: 'ocr / find_text: long-side pixel limit handed to the engine. Lower is faster; default 1024.',
      },
      minScore: {
        type: 'number',
        description:
          'ocr: confidence below which a line is left out of the joined "text" (default 0.5). "lines" always contains every line. find_text ignores this.',
      },
      frames: {
        type: 'number',
        description: 'ocr: for a video, how many frames to read, spread evenly. Defaults to 4; at most 24.',
      },
      times: {
        type: 'array',
        items: { type: 'number' },
        description: 'ocr: for a video, the exact seconds to read instead of evenly spread frames.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
