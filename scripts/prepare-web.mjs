import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, 'public/vendor/ffmpeg');
await mkdir(destination, { recursive: true });
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await copyFile(join(root, 'node_modules/@ffmpeg/core/dist/esm', file), join(destination, file));
}
console.log('Web用FFmpegをローカル配信フォルダーへ準備しました。');
