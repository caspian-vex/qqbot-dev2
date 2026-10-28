// 消息处理引擎。
export { Engine, type EngineOptions, type Sender } from './engine';
export { ECHO_INSTRUCTION, echoDelayMs, shouldEcho, type EchoGateState } from './echo';
export {
  dedupeImages,
  dedupeKeepOrder,
  extractImageTags,
  imageBase64,
  imageLabel,
  listPool,
  normalizeTagName,
  pickImage,
  poolFilePath,
  poolPromptBlock,
  resolveImage,
  sanitizeStem,
  sniffImageExt,
  tagDirOf,
  uniqueName,
  IMAGE_EXTS,
  IMAGE_MIME,
  MAX_FILES_PER_TAG,
  MAX_IMAGE_BYTES,
  MAX_TAGS_LISTED,
  UNTAGGED,
  isValidTagName,
  type PoolImage,
  type PoolTag,
} from './imagepool';
export { decide, matchWakeWord, stripWakeWords, type Decision } from './filter';
export { split, stripMarkdown, truncate, defaultSplit, type SplitOptions } from './split';
export { Cooldown, Dedupe, TaskQueue } from './queue';
