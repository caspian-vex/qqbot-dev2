// 打包脚本：把 src/main.ts 打成一个 CJS 单文件，输出 dist/server.js。
//
// 为什么是 CJS 而不是 ESM：
//   ws 是 CJS 包，内部用 try { require('bufferutil') } catch {} 做可选原生加速。
//   打成 ESM 需要 createRequire banner + 手动 external，纯属自找麻烦。
//   打 CJS 则 esbuild 能直接把它折进来，运行时不需要 node_modules。
//
// 为什么单文件：
//   产物与架构无关（纯 JS），一个 tarball 同时覆盖 amd64/arm64；
//   镜像里也不需要 node_modules，启动只读一个文件。
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// CI 用 git tag 传版本号；本地构建退回 package.json 里的版本
const version = process.env.QQBOT_VERSION ?? pkg.version;
const commit = process.env.QQBOT_COMMIT ?? 'dev';
const buildDate = process.env.QQBOT_BUILD_DATE ?? new Date().toISOString();

await build({
  // 两个入口：
  //   server.js        —— 主程序
  //   argon-worker.js  —— argon2id 计算 worker（见 src/panel/auth.ts 的说明）
  // 不用单入口 + eval 内联 worker，是因为那样得把 hash-wasm 的 WASM
  // 以 base64 塞进字符串，产物膨胀近 1MB 且完全没法调试。
  entryPoints: {
    server: 'src/main.ts',
    'argon-worker': 'src/panel/argon-worker.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: 'dist',
  // 只保留 Node 内置模块为外部依赖；ws/qrcode 等第三方包全部打进来
  external: ['node:*'],
  // 可选原生加速模块：ws 会在 try/catch 里 require，标记外部即可，缺失也不影响
  define: {
    __QQBOT_VERSION__: JSON.stringify(version),
    __QQBOT_COMMIT__: JSON.stringify(commit),
    __QQBOT_BUILD_DATE__: JSON.stringify(buildDate),
  },
  banner: {
    js: '/* qqbot - bundled by esbuild. Do not edit. */',
  },
  logLevel: 'info',
});
