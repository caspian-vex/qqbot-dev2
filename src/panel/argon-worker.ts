// argon2id 计算 worker。
//
// 单独一个产物文件（dist/argon-worker.js），由 auth.ts 用 worker_threads 拉起。
// 存在的唯一理由：把 100ms 的 CPU 密集计算挪出主线程，
// 否则单核机器上每次面板登录都会让机器人卡一下。
import { parentPort } from 'node:worker_threads';
import { argon2id } from 'hash-wasm';

interface Request {
  id: number;
  password: string;
  salt: Uint8Array;
  memory: number;
  time: number;
  threads: number;
  keyLen: number;
}

if (!parentPort) {
  throw new Error('argon-worker 必须作为 worker_threads 运行');
}

const port = parentPort;

port.on('message', (req: Request) => {
  void (async () => {
    try {
      const key = await argon2id({
        password: req.password,
        salt: req.salt,
        // memorySize 单位是 KiB，与 Go 的 argon2.IDKey 一致（65536 = 64MiB）
        memorySize: req.memory,
        iterations: req.time,
        parallelism: req.threads,
        hashLength: req.keyLen,
        outputType: 'binary',
      });
      port.postMessage({ id: req.id, ok: true, key });
    } catch (e) {
      port.postMessage({ id: req.id, ok: false, error: (e as Error).message });
    }
  })();
});
