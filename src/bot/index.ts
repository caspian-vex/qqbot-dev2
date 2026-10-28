// 消息处理引擎。
export { Engine, type EngineOptions, type Sender } from './engine';
export { ECHO_INSTRUCTION, echoDelayMs, shouldEcho, type EchoGateState } from './echo';
export { decide, matchWakeWord, stripWakeWords, type Decision } from './filter';
export { split, stripMarkdown, truncate, defaultSplit, type SplitOptions } from './split';
export { Cooldown, Dedupe, TaskQueue } from './queue';
