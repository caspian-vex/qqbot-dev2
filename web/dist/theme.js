/* 在首帧之前应用外观设置。
 *
 * 为什么单独一个文件：服务端 CSP 是 script-src 'self'，index.html 里不能写内联脚本；
 * 而这段逻辑必须跑在样式表生效之前，否则浅色用户每次刷新都会先看到一帧暗色（闪屏）。
 * 所以它在 <head> 里同步加载，app.js 在 body 末尾只负责切换器与系统主题监听。
 *
 * 取值：light / dark / system（默认 dark —— 面板上线以来一直是暗色，升级不改变观感）
 */
(() => {
  'use strict';
  const KEY = 'qqbot-theme';
  let mode = 'dark';
  try {
    mode = localStorage.getItem(KEY) || 'dark';
  } catch (_) {
    /* 隐私模式下 localStorage 可能抛异常，退回暗色即可 */
  }
  let dark = mode === 'dark';
  if (mode === 'system') {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
