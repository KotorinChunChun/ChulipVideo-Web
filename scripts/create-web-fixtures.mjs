import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const evidenceDirectory = path.join(projectRoot, "dev/history/v0.3.0/logs/web-browser-test");
export const ffmpegPath = process.env.CHULIP_TEST_FFMPEG ?? "ffmpeg";

export function runFfmpeg(args, options = {}) {
  const result = spawnSync(ffmpegPath, args, { encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error?.code === "ENOENT") throw new Error(`検証用 FFmpeg が見つかりません。PATH に追加するか、CHULIP_TEST_FFMPEG に実行ファイルのパスを指定してください: ${ffmpegPath}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`FFmpeg の検証に失敗しました（${result.status}）: ${String(result.stderr).slice(-6000)}`);
  return result;
}

/** 実素材を使わず、長さ・FPS・音声の有無が既知の素材を毎回生成する。 */
export async function createFixtures() {
  const directory = path.join(evidenceDirectory, "fixtures");
  await mkdir(directory, { recursive: true });
  const fixtures = {
    audio: path.join(directory, "音声付き_320x180_12fps.mp4"),
    silent: path.join(directory, "無音_320x180_12fps.mp4"),
    broken: path.join(directory, "破損.mp4"),
    input: path.join(directory, "音声付き_320x180_12fps.tsv"),
  };
  const logs = [];
  const base = ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=5"];
  const audio = runFfmpeg([...base, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "12", "-c:a", "aac", "-b:a", "96k", "-t", "5", "-movflags", "+faststart", fixtures.audio]);
  logs.push(`音声付き素材\n${audio.stderr}`);
  const silent = runFfmpeg([...base, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "12", "-an", "-t", "5", "-movflags", "+faststart", fixtures.silent]);
  logs.push(`無音素材\n${silent.stderr}`);
  await writeFile(fixtures.broken, "これは動画ではありません。破損ファイルの回復確認用です。\n", "utf8");
  await writeFile(fixtures.input, [
    "Timestamp\tFrame\tX\tY\tClick\tKeys",
    "0.000\t0\t40\t45\tNone\tNone",
    "0.500\t6\t60\t50\tNone\tCtrl,C",
    "1.200\t14\t80\t60\tL-Click\tNone",
    "1.500\t18\t110\t65\tNone\tEnter",
    "1.800\t22\t135\t75\tNone\tNone",
    "2.500\t30\t140\t90\tWheel-Down\tNone",
    "3.500\t42\t200\t110\tR-Click\tNone",
    "4.900\t59\t230\t120\tNone\tNone",
    "",
  ].join("\r\n"), "utf8");
  await writeFile(path.join(evidenceDirectory, "fixture-generation.log"), logs.join("\n\n"), "utf8");
  await writeFile(path.join(evidenceDirectory, "fixtures.json"), JSON.stringify({ ffmpeg: ffmpegPath, duration: 5, width: 320, height: 180, fps: 12, frames: 60, files: fixtures }, null, 2), "utf8");
  return fixtures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createFixtures().then(fixtures => console.log(JSON.stringify(fixtures, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
