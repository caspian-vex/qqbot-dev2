// 版本信息。
//
// 三个常量由 esbuild 的 define 在打包时注入（见 esbuild.mjs）；
// 用 tsx 直接跑源码时它们并不存在，所以必须包在 try 里读——
// 一个未定义的标识符在运行时是 ReferenceError，不是 undefined。
declare const __QQBOT_VERSION__: string;
declare const __QQBOT_COMMIT__: string;
declare const __QQBOT_BUILD_DATE__: string;

function read(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const VERSION = read(() => __QQBOT_VERSION__, 'dev');
export const COMMIT = read(() => __QQBOT_COMMIT__, 'dev');
export const BUILD_DATE = read(() => __QQBOT_BUILD_DATE__, 'unknown');

/** 单行版本串，`qqbot version` 与启动日志共用。 */
export function versionString(): string {
  return `qqbot ${VERSION} (${COMMIT} @ ${BUILD_DATE})`;
}
