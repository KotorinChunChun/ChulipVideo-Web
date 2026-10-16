import { FFmpeg, type FFFSType } from "@ffmpeg/ffmpeg";
import { Zip, ZipPassThrough } from "fflate";
import type { ExportRequest, InputRecord, OverlaySettings, VideoMetadata } from "../tauriApi";
import { buildAss } from "./overlay";

const MIB = 1024 * 1024;
export const MEDIA_LIMITS = Object.freeze({ outputBytes: 512 * MIB, dimension: 8192, pngFrames: 1000, pngPixelBytes: 512 * MIB });
const metadataCache = new WeakMap<File, VideoMetadata>();
let engine: FFmpeg | null = null;
let queue: Promise<void> = Promise.resolve();
let sequence = 0;
let fontEngine: FFmpeg | null = null;

type JobContext = { ffmpeg: FFmpeg; directory: string; input: string; logs: string[]; signal?: AbortSignal };
export type RenderedMedia = { data: Uint8Array; mime: string; filename: string };
type OverlayPass = { phase: "pointer" | "subtitle"; width: number; height: number; settings: OverlaySettings };

function abortError() { return new DOMException("処理をキャンセルしました。", "AbortError"); }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
function baseUrl() { return new URL(import.meta.env?.BASE_URL ?? "/", document.baseURI).href; }
function finiteNumber(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && !value.trim()) return NaN;
  return Number(value);
}
function positiveNumber(...values: unknown[]): number {
  for (const value of values) { const number = finiteNumber(value); if (Number.isFinite(number) && number > 0) return number; }
  return NaN;
}
function ratio(value: unknown): number {
  if (typeof value === "string" && value.includes("/")) {
    const [numerator, denominator, extra] = value.split("/");
    if (extra !== undefined) return NaN;
    return finiteNumber(numerator) / finiteNumber(denominator);
  }
  return finiteNumber(value);
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function validateDimensions(width: number, height: number) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= MEDIA_LIMITS.dimension)) {
    throw new Error(`試作版では動画・出力・中間画像の幅と高さを 1～${MEDIA_LIMITS.dimension} px にしてください。`);
  }
}

/** ffprobe の終了コードだけを信頼せず、映像ストリームと数値を検証する。 */
export function parseProbeMetadata(raw: string, filename: string): VideoMetadata {
  let parsed: Record<string, unknown>;
  try { parsed = object(JSON.parse(raw)); } catch { throw new Error("動画情報を読み取れませんでした（ffprobe の JSON が不正です）。"); }
  const streams = Array.isArray(parsed.streams) ? parsed.streams.map(object) : [];
  const stream = streams.find(value => value.codec_type === "video" && object(value.disposition).attached_pic !== 1);
  if (!stream) throw new Error("映像ストリームのある動画ファイルを選択してください。");
  const format = object(parsed.format);
  const duration = positiveNumber(stream.duration, format.duration, finiteNumber(stream.duration_ts) * ratio(stream.time_base));
  const frameCountValue = finiteNumber(stream.nb_frames);
  const frameCount = Number.isSafeInteger(frameCountValue) && frameCountValue > 0 ? frameCountValue : null;
  const fps = positiveNumber(ratio(stream.avg_frame_rate), ratio(stream.r_frame_rate), frameCount === null ? NaN : frameCount / duration);
  if (!Number.isFinite(duration) || !Number.isFinite(fps)) throw new Error("動画の再生時間または FPS を取得できませんでした。別の動画形式で試してください。");
  let width = finiteNumber(stream.width), height = finiteNumber(stream.height);
  validateDimensions(width, height);
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list.map(object) : [];
  const rotation = finiteNumber(sideData.find(value => value.rotation !== undefined)?.rotation ?? object(stream.tags).rotate ?? 0);
  if (Number.isFinite(rotation) && Math.abs(Math.round(rotation)) % 180 === 90) [width, height] = [height, width];
  return { path: filename, duration, width, height, fps, frameCount, formatName: String(format.format_name ?? "unknown"), codecName: String(stream.codec_name ?? "unknown") };
}

/** 原動画座標で合成した後に適用する。RGBA 化で奇数座標の色差丸めを防ぐ。 */
export function buildCropFilters(width: number, height: number, crop: ExportRequest["crop"], even: boolean): string[] {
  validateDimensions(width, height);
  const filters: string[] = [];
  let outputWidth = width, outputHeight = height;
  if (crop) {
    if (![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger)) throw new Error("切り抜き範囲には整数の座標と大きさを指定してください。");
    validateDimensions(crop.width, crop.height);
    const left = Math.max(0, -crop.x), top = Math.max(0, -crop.y);
    const paddedWidth = Math.max(width + left, crop.x + left + crop.width);
    const paddedHeight = Math.max(height + top, crop.y + top + crop.height);
    validateDimensions(paddedWidth, paddedHeight);
    filters.push("format=rgba", `pad=${paddedWidth}:${paddedHeight}:${left}:${top}:color=black`, `crop=${crop.width}:${crop.height}:${crop.x + left}:${crop.y + top}:exact=1`);
    outputWidth = crop.width; outputHeight = crop.height;
  }
  if (even && (outputWidth % 2 || outputHeight % 2)) {
    validateDimensions(outputWidth + outputWidth % 2, outputHeight + outputHeight % 2);
    filters.push(`pad=${outputWidth + outputWidth % 2}:${outputHeight + outputHeight % 2}:0:0:color=black`);
  }
  return filters;
}

/** ポインターは元動画座標、字幕はクロップ後の出力下部へ配置する。 */
export function buildOverlayPasses(width: number, height: number, crop: ExportRequest["crop"], even: boolean, settings: OverlaySettings | null): OverlayPass[] {
  if (!settings) return [];
  const passes: OverlayPass[] = [];
  if (settings.showPointer) passes.push({ phase: "pointer", width, height, settings: { ...settings, showSubtitles: false } });
  if (settings.showSubtitles) {
    const outputWidth = crop?.width ?? width, outputHeight = crop?.height ?? height;
    passes.push({ phase: "subtitle", width: outputWidth + (even ? outputWidth % 2 : 0), height: outputHeight + (even ? outputHeight % 2 : 0), settings: { ...settings, showPointer: false, showClickRipple: false } });
  }
  return passes;
}

export function validateExportRequest(metadata: VideoMetadata, request: ExportRequest): { duration: number; fps: number; frames: number } {
  if (![request.start, request.end].every(Number.isFinite) || request.start < 0 || request.end <= request.start || request.start >= metadata.duration || request.end > metadata.duration + 0.001) {
    throw new Error("出力範囲は動画内の開始時刻から終了時刻までを指定してください（開始 < 終了）。");
  }
  if (!["png-sequence", "mp4", "gif"].includes(request.format)) throw new Error("未対応の出力形式です。");
  const fps = request.format === "gif" ? 15 : request.fps ?? metadata.fps;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("試作版の出力 FPS は 0 より大きく 240 以下にしてください。");
  if (![request.quality, request.pngCompression].every(Number.isFinite)) throw new Error("出力品質の値が不正です。");
  buildCropFilters(metadata.width, metadata.height, request.crop, request.format === "mp4");
  const duration = Math.min(request.end, metadata.duration) - request.start;
  const frames = Math.ceil(duration * fps - 1e-7);
  if (request.format === "png-sequence") {
    if (frames > MEDIA_LIMITS.pngFrames) throw new Error(`試作版の PNG 連番は ${MEDIA_LIMITS.pngFrames} 枚までです。出力範囲を短くしてください。`);
    const pixels = (request.crop?.width ?? metadata.width) * (request.crop?.height ?? metadata.height);
    if (pixels * 4 * frames > MEDIA_LIMITS.pngPixelBytes) throw new Error("試作版の PNG 連番は展開後の画素データ合計 512 MiB までです。出力範囲または画像サイズを小さくしてください。");
  }
  return { duration, fps, frames };
}

function errorWithLogs(error: unknown, logs: string[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  const recent = logs.filter(value => /error|invalid|failed|unsupported|not found|cannot|out of memory|abort/i.test(value)).slice(-4);
  const detail = (recent.length ? recent : logs.slice(-3)).join("\n").slice(-1400);
  return new Error(`動画処理に失敗しました: ${message}${detail ? `\n${detail}` : ""}`);
}

// 待機中の中止はその Promise だけを取り消し、実行中の別ジョブには触れない。
function enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  const scheduled = queue.then(() => { checkAbort(signal); return operation(); });
  queue = scheduled.then(() => undefined, () => undefined);
  if (!signal) return scheduled;
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(abortError());
    signal.addEventListener("abort", cancelled, { once: true });
    scheduled.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelled));
    if (signal.aborted) cancelled();
  });
}

async function withFile<T>(file: File, operation: (context: JobContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!file.size) throw new Error("空のファイルは読み込めません。");
  return enqueue(async () => {
    checkAbort(signal);
    const ffmpeg = engine ?? new FFmpeg();
    engine = ffmpeg;
    const directory = `/job-${++sequence}`;
    const extension = file.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? ".media";
    const mountPoint = `${directory}/source`;
    const inputName = `input${extension}`;
    let mounted = false;
    const context: JobContext = { ffmpeg, directory, input: `${mountPoint}/${inputName}`, logs: [], signal };
    const log = ({ message }: { message: string }) => { context.logs.push(message); if (context.logs.length > 30) context.logs.shift(); };
    const terminate = () => {
      if (engine === ffmpeg) { engine = null; fontEngine = null; ffmpeg.terminate(); }
    };
    ffmpeg.on("log", log);
    signal?.addEventListener("abort", terminate, { once: true });
    try {
      checkAbort(signal);
      if (!ffmpeg.loaded) await ffmpeg.load({ coreURL: `${baseUrl()}vendor/ffmpeg/ffmpeg-core.js`, wasmURL: `${baseUrl()}vendor/ffmpeg/ffmpeg-core.wasm` });
      checkAbort(signal);
      await ffmpeg.createDir(directory);
      await ffmpeg.createDir(mountPoint);
      // Fileを読み取り専用でマウントし、大容量入力の全体コピーを避ける。
      mounted = await ffmpeg.mount("WORKERFS" as FFFSType, { blobs: [{ name: inputName, data: file }] }, mountPoint);
      if (!mounted) throw new Error("動画ファイルの読み込み領域を準備できませんでした。");
      checkAbort(signal);
      return await operation(context);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      // 失敗後の core 内部状態を次の処理へ持ち越さない。
      terminate();
      throw errorWithLogs(error, context.logs);
    } finally {
      signal?.removeEventListener("abort", terminate);
      ffmpeg.off("log", log);
      if (engine === ffmpeg && ffmpeg.loaded) {
        try {
          if (mounted) await ffmpeg.unmount(mountPoint);
          await ffmpeg.deleteDir(mountPoint);
          for (const entry of await ffmpeg.listDir(directory)) if (!entry.isDir) await ffmpeg.deleteFile(`${directory}/${entry.name}`);
          await ffmpeg.deleteDir(directory);
        } catch { terminate(); }
      }
    }
  }, signal);
}

async function binary(ffmpeg: FFmpeg, path: string): Promise<Uint8Array> {
  const data = await ffmpeg.readFile(path);
  if (typeof data === "string" || !data.byteLength) throw new Error("出力ファイルを生成できませんでした。");
  if (data.byteLength >= MEDIA_LIMITS.outputBytes) throw new Error("試作版の出力容量上限 512 MiB に達しました。出力範囲または画像サイズを小さくしてください。");
  return data;
}

async function probe(context: JobContext, file: File): Promise<VideoMetadata> {
  const cached = metadataCache.get(file);
  if (cached) return cached;
  const output = `${context.directory}/probe.json`;
  const code = await context.ffmpeg.ffprobe(["-v", "error", "-show_streams", "-show_format", "-of", "json", context.input, "-o", output]);
  // core 0.12.10 の ffprobe は有効な JSON を保存しても -1 を返す場合がある。
  if (code !== 0 && code !== -1) throw new Error(`動画情報の取得に失敗しました（終了コード ${code}）。`);
  const raw = await context.ffmpeg.readFile(output, "utf8");
  const metadata = parseProbeMetadata(typeof raw === "string" ? raw : new TextDecoder().decode(raw), file.name);
  metadataCache.set(file, metadata);
  await context.ffmpeg.deleteFile(output);
  return metadata;
}

async function prepareOverlay(context: JobContext, pass: OverlayPass | undefined, records: InputRecord[], start: number, end: number): Promise<string[]> {
  if (!pass || !records.length) return [];
  if (fontEngine !== context.ffmpeg) {
    const response = await fetch(`${baseUrl()}vendor/fonts/NotoSansJP-Regular.otf`, { signal: context.signal });
    if (!response.ok) throw new Error(`字幕用フォントを取得できませんでした（HTTP ${response.status}）。`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    checkAbort(context.signal);
    await context.ffmpeg.createDir("/fonts");
    await context.ffmpeg.writeFile("/fonts/NotoSansJP-Regular.otf", bytes);
    fontEngine = context.ffmpeg;
  }
  const filename = `${context.directory}/${pass.phase}.ass`;
  await context.ffmpeg.writeFile(filename, buildAss(records, pass.settings, pass.width, pass.height, start, end));
  return [`ass=filename=${filename}:fontsdir=/fonts`];
}

function filenameFor(file: File, request: ExportRequest): string {
  const extension = request.format === "png-sequence" ? "zip" : request.format;
  const requested = request.output.split(/[\\/]/).pop() || file.name;
  const stem = requested.replace(/\.[^.]*$/, "").replace(/%0?\d*d/g, "frames").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "output";
  return `${stem}.${extension}`;
}

async function zipFrames(context: JobContext, onProgress: (ratio: number) => void): Promise<Uint8Array> {
  const entries = (await context.ffmpeg.listDir(context.directory)).filter(entry => !entry.isDir && /^frame-\d+\.png$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.length) throw new Error("指定した範囲に出力できるフレームがありません。");
  const chunks: Uint8Array[] = [];
  let size = 0, failure: Error | null = null;
  const archive = new Zip((error, data) => {
    if (error) { failure = error; return; }
    size += data.byteLength;
    if (size >= MEDIA_LIMITS.outputBytes) { failure = new Error("試作版の ZIP 出力容量上限 512 MiB に達しました。範囲を短くしてください。"); return; }
    chunks.push(data);
  });
  try {
    for (let index = 0; index < entries.length; index++) {
      checkAbort(context.signal);
      const path = `${context.directory}/${entries[index].name}`;
      const data = await binary(context.ffmpeg, path);
      await context.ffmpeg.deleteFile(path);
      const entry = new ZipPassThrough(entries[index].name);
      archive.add(entry);
      entry.push(data, true);
      if (failure) throw failure;
      onProgress(0.95 + (index + 1) / entries.length * 0.04);
    }
    archive.end();
    if (failure) throw failure;
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { archive.terminate(); }
}

export async function probeFile(file: File): Promise<VideoMetadata> {
  const cached = metadataCache.get(file);
  return cached ?? withFile(file, context => probe(context, file));
}

/** MOV/MKV/HEVCはOSのデコーダーに依存しない再生用MP4を作る。書出しは原本を使う。 */
export function needsPlaybackProxy(file: Pick<File, "name" | "type">, metadata: VideoMetadata): boolean {
  return /\.(mov|m4v|mkv)$/i.test(file.name) || ["video/quicktime", "video/x-matroska", "video/matroska", "application/x-matroska"].includes(file.type.toLowerCase()) || ["hevc", "h265", "prores"].includes(metadata.codecName.toLowerCase());
}

export async function playbackProxy(file: File): Promise<Uint8Array> {
  return withFile(file, async context => {
    const original = await probe(context, file);
    const output = `${context.directory}/playback.mp4`;
    const code = await context.ffmpeg.exec(["-i", context.input, "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ac", "2", "-b:a", "128k", "-map_metadata", "-1", "-movflags", "+faststart",
      "-fs", String(MEDIA_LIMITS.outputBytes), output]);
    if (code !== 0) throw new Error(`再生用MP4の作成に失敗しました（${code}）。`);
    const infoPath = `${context.directory}/playback.json`;
    await context.ffmpeg.ffprobe(["-v", "error", "-show_streams", "-show_format", "-of", "json", output, "-o", infoPath]);
    const raw = await context.ffmpeg.readFile(infoPath);
    const converted = parseProbeMetadata(typeof raw === "string" ? raw : new TextDecoder().decode(raw), file.name);
    if (converted.duration < original.duration - Math.max(0.25, 2 / original.fps)) {
      throw new Error("再生用MP4を最後まで作成できませんでした。動画を短くするか容量を小さくしてください。");
    }
    return binary(context.ffmpeg, output);
  });
}

export async function renderMedia(file: File, request: ExportRequest, overlay: OverlaySettings | null, records: InputRecord[], onProgress: (ratio: number) => void, signal: AbortSignal): Promise<RenderedMedia> {
  return withFile(file, async context => {
    onProgress(0);
    const metadata = await probe(context, file);
    const { duration, fps, frames } = validateExportRequest(metadata, request);
    const passes = buildOverlayPasses(metadata.width, metadata.height, request.crop, request.format === "mp4", overlay);
    const filters = [`trim=duration=${duration.toFixed(6)}`, "setpts=PTS-STARTPTS", ...await prepareOverlay(context, passes.find(pass => pass.phase === "pointer"), records, request.start, request.start + duration), ...buildCropFilters(metadata.width, metadata.height, request.crop, request.format === "mp4"), ...await prepareOverlay(context, passes.find(pass => pass.phase === "subtitle"), records, request.start, request.start + duration), `fps=${fps.toFixed(9)}`, "setsar=1"];
    const output = `${context.directory}/${request.format === "png-sequence" ? "frame-%06d.png" : `output.${request.format}`}`;
    const args = ["-hide_banner", "-loglevel", "info", "-ss", request.start.toFixed(6), "-i", context.input, "-t", duration.toFixed(6)];
    if (request.format === "gif") {
      args.push("-filter_complex", `[0:V:0]${filters.join(",")},split[a][b];[a]palettegen=stats_mode=diff:reserve_transparent=0[p];[b][p]paletteuse=dither=sierra2_4a[v]`, "-map", "[v]", "-an", "-loop", "0", "-fs", String(MEDIA_LIMITS.outputBytes));
    } else {
      args.push("-map", "0:V:0", "-vf", filters.join(","));
      if (request.format === "mp4") {
        const quality = Math.max(0, Math.min(100, request.quality));
        const crf = Math.max(12, Math.min(35, 35 - Math.floor(quality * 23 / 100)));
        args.push("-map", "0:a:0?", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-crf", String(crf), "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-fs", String(MEDIA_LIMITS.outputBytes));
      } else {
        args.push("-an", "-frames:v", String(frames), "-compression_level", String(Math.round(Math.max(0, Math.min(9, request.pngCompression)))));
      }
    }
    args.push(output);
    const progress = ({ time }: { time: number }) => { if (Number.isFinite(time)) onProgress(Math.max(0, Math.min(0.94, time / (duration * 1e6) * 0.94))); };
    context.ffmpeg.on("progress", progress);
    try {
      checkAbort(signal);
      const code = await context.ffmpeg.exec(args);
      if (code !== 0) throw new Error(`FFmpeg の終了コード: ${code}`);
    } finally { context.ffmpeg.off("progress", progress); }
    checkAbort(signal);
    const data = request.format === "png-sequence" ? await zipFrames(context, onProgress) : await binary(context.ffmpeg, output);
    checkAbort(signal);
    onProgress(1);
    return { data, mime: request.format === "png-sequence" ? "application/zip" : request.format === "mp4" ? "video/mp4" : "image/gif", filename: filenameFor(file, request) };
  }, signal);
}

export async function renderFrame(file: File, timestamp: number, crop: ExportRequest["crop"], overlay: OverlaySettings | null, records: InputRecord[], pngCompression: number): Promise<Uint8Array> {
  return withFile(file, async context => {
    const metadata = await probe(context, file);
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > metadata.duration) throw new Error("画像化する時刻が動画の範囲外です。");
    if (!Number.isFinite(pngCompression)) throw new Error("PNG 圧縮率が不正です。");
    const start = Math.min(timestamp, Math.max(0, metadata.duration - 1 / metadata.fps));
    const passes = buildOverlayPasses(metadata.width, metadata.height, crop, false, overlay);
    const filters = ["setpts=PTS-STARTPTS", ...await prepareOverlay(context, passes.find(pass => pass.phase === "pointer"), records, start, start + 1 / metadata.fps), ...buildCropFilters(metadata.width, metadata.height, crop, false), ...await prepareOverlay(context, passes.find(pass => pass.phase === "subtitle"), records, start, start + 1 / metadata.fps), "setsar=1"];
    const output = `${context.directory}/frame.png`;
    const code = await context.ffmpeg.exec(["-hide_banner", "-loglevel", "info", "-ss", start.toFixed(6), "-i", context.input, "-map", "0:V:0", "-vf", filters.join(","), "-frames:v", "1", "-an", "-update", "1", "-compression_level", String(Math.round(Math.max(0, Math.min(9, pngCompression)))), output]);
    if (code !== 0) throw new Error(`画像化に失敗しました（終了コード ${code}）。`);
    return binary(context.ffmpeg, output);
  });
}

export async function previewFile(file: File, timestamp: number): Promise<Uint8Array> {
  return renderFrame(file, timestamp, null, null, [], 1);
}
