import type { ExportJob, ExportRequest, GlobalConfig, InputRecord, OverlaySettings, VideoSettings } from "../tauriApi";
import { parseInputTsv } from "./overlay";

type Source = { file: File; url: string; records: InputRecord[]; playbackReady?: boolean };
type Download = { url: string; filename: string; size: number };
const sources = new Map<string, Source>();
const jobs = new Map<string, ExportJob>();
const controllers = new Map<string, AbortController>();
const downloads = new Map<string, Download>();
const listeners = new Set<(job: ExportJob) => void>();
const CONFIG_KEY = "chulip-video:web:config:v1";
let exportQueue: Promise<unknown> = Promise.resolve();
const media = () => import("./media");

export const defaultConfig: GlobalConfig = {
  last_video_path: "", resolution_presets: { HD: [1280, 720], FullHD: [1920, 1080], "正方形": [720, 720] },
  selected_ratio: "未指定", png_compression: 3, check_prev_next: false, check_duplicate: false,
  play_speed: 1, restore_last_video: false, seek_step: "1秒", play_range: false, play_loop: false,
  play_pingpong: false, show_trajectory: true, show_subtitle: true, embed_overlay: true,
  aspect_options: ["未指定", "16:9", "4:3", "1:1"], open_output_directory: false, confirm_overwrite: false,
  video_output_directory: "", image_output_directory: "", overlay_pointer_size: 36,
  overlay_pointer_color: "#ffffff", overlay_pointer_outline: "#111111", overlay_ripple: true,
  overlay_ripple_duration: 0.5, overlay_subtitle_duration: 1.2, overlay_subtitle_stack: 3,
  overlay_subtitle_font_size: 30, overlay_subtitle_color: "#202020", overlay_subtitle_background: "#ffffff",
};

function source(path: string): Source {
  const value = sources.get(path);
  if (!value) throw new Error("動画を選択し直してください。");
  return value;
}
function readStored<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    const value = text ? JSON.parse(text) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? { ...fallback, ...value } : fallback;
  } catch { return fallback; }
}
function writeStored(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { throw new Error("ブラウザの保存領域に設定を保存できません。空き容量やブラウザの設定を確認してください。"); }
}
function settingsKey(path: string) {
  const { file } = source(path);
  return `chulip-video:web:video:v1:${JSON.stringify([file.name, file.size, file.lastModified])}`;
}

export async function loadGlobalConfig() {
  const value = readStored(CONFIG_KEY, defaultConfig);
  // ブラウザは名前だけからローカル動画へ再アクセスしない。
  return { path: "ブラウザ内", value: { ...value, restore_last_video: false, open_output_directory: false, video_output_directory: "", image_output_directory: "" } };
}
export async function saveGlobalConfig(value: GlobalConfig) { writeStored(CONFIG_KEY, value); return "ブラウザ内"; }
export async function loadVideoSettings(video: string) {
  const defaults: VideoSettings = { video_file: video, crop_rect: null, start_time: 0, end_time: 0, current_time: 0, allow_oversize: false, png_compression: 3 };
  return { path: "ブラウザ内", value: readStored(settingsKey(video), defaults) };
}
export async function saveVideoSettings(video: string, value: VideoSettings) { writeStored(settingsKey(video), value); return "ブラウザ内"; }

export function registerVideo(file: File): string {
  if (!file.size) throw new Error("空のファイルは読み込めません。");
  const id = `browser:${crypto.randomUUID()}`;
  sources.set(id, { file, url: URL.createObjectURL(file), records: [] });
  return id;
}
export function getVideoUrl(path: string) { return source(path).url; }
export function getSourceName(path: string) { return source(path).file.name; }
export function discardVideo(path: string) {
  const value = sources.get(path);
  if (value) URL.revokeObjectURL(value.url);
  sources.delete(path);
}
export function retainVideo(path: string) {
  for (const id of sources.keys()) if (id !== path) discardVideo(id);
}
export function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = accept; input.hidden = true;
    const finish = (file: File | null) => { input.remove(); resolve(file); };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.append(input); input.click();
  });
}
export async function openVideoDialog() {
  const file = await chooseFile("video/*,.mkv,.avi,.mov,.webm,.gif");
  return file ? registerVideo(file) : null;
}
export async function probeVideo(path: string) { return (await media()).probeFile(source(path).file); }
export async function preparePlayback(path: string, onStatus: (message: string) => void) {
  const value = source(path);
  if (value.playbackReady) return;
  const processor = await media();
  const metadata = await processor.probeFile(value.file);
  if (processor.needsPlaybackProxy(value.file, metadata)) {
    onStatus("動画の再生用MP4を端末内で準備しています…（長い動画は時間がかかります）");
    const data = await processor.playbackProxy(value.file);
    if (sources.get(path) !== value) return;
    const nextUrl = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "video/mp4" }));
    URL.revokeObjectURL(value.url);
    value.url = nextUrl;
  }
  value.playbackReady = true;
}
export async function extractPreview(path: string, timestamp: number) { return (await media()).previewFile(source(path).file, timestamp); }
export async function loadInputHistory(video: string) { return source(video).records; }
export async function selectInputHistory(video: string) {
  const file = await chooseFile(".tsv,text/tab-separated-values,text/plain");
  if (!file) return null;
  if (file.size > 20 * 1024 * 1024) throw new Error("操作履歴は20MiB以下にしてください。");
  const records = parseInputTsv(await file.text());
  source(video).records = records;
  return records;
}
export async function pathExists() { return false; }
export async function revealPath() { /* ブラウザ版の保存はダウンロードリンクを使う。 */ }

function emit(job: ExportJob) {
  jobs.set(job.id, { ...job });
  for (const listener of listeners) listener({ ...job });
}
export function listenExportJobs(listener: (job: ExportJob) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export async function listExportJobs() { return [...jobs.values()].reverse().map((job) => ({ ...job })); }
export function getDownload(id: string) { return downloads.get(id); }
function saveDownload(job: ExportJob, data: Uint8Array, mime: string, filename: string) {
  const blob = new Blob([new Uint8Array(data)], { type: mime });
  // 結果を無制限に保持しない。古いダウンロードは最大3件/合計512MiBで解放する。
  let total = blob.size;
  let retained = 1;
  const previous = [...downloads.entries()];
  for (let index = previous.length - 1; index >= 0; index--) {
    const [id, download] = previous[index];
    if (retained >= 3 || total + download.size > 512 * 1024 * 1024) {
      URL.revokeObjectURL(download.url); downloads.delete(id);
      const oldJob = jobs.get(id);
      if (oldJob) emit({ ...oldJob, message: "保存リンクを解放しました。必要な場合は再出力してください。" });
    } else { total += download.size; retained++; }
  }
  downloads.set(job.id, { url: URL.createObjectURL(blob), filename, size: blob.size });
}
export async function startExportJob(request: ExportRequest, overlay: OverlaySettings | null): Promise<ExportJob> {
  const selected = source(request.input);
  const file = selected.file;
  const records = [...selected.records];
  const id = crypto.randomUUID();
  const controller = new AbortController();
  controllers.set(id, controller);
  const job: ExportJob = { id, state: "queued", format: request.format, output: request.output, progress: 0, message: "順番を待っています" };
  emit(job);
  exportQueue = exportQueue.catch(() => undefined).then(async () => {
    if (controller.signal.aborted) return;
    emit({ ...job, state: "running", message: "端末内で書き出しています" });
    try {
      const result = await (await media()).renderMedia(file, request, overlay, records, (ratio) => {
        if (!controller.signal.aborted) emit({ ...job, state: "running", progress: Math.max(0, Math.min(0.99, ratio)), message: "端末内で書き出しています" });
      }, controller.signal);
      if (controller.signal.aborted) return;
      saveDownload(job, result.data, result.mime, result.filename);
      emit({ ...job, state: "completed", output: result.filename, progress: 1, message: "生成完了。ダウンロードから保存できます" });
    } catch (error) {
      if (!controller.signal.aborted) emit({ ...job, state: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally { controllers.delete(id); }
  });
  return { ...job };
}
export async function cancelExportJob(id: string) {
  const job = jobs.get(id);
  if (!job) throw new Error("出力処理が見つかりません。");
  if (!["queued", "running", "cancelling"].includes(job.state)) return job;
  controllers.get(id)?.abort(); controllers.delete(id);
  const cancelled: ExportJob = { ...job, state: "cancelled", message: "キャンセルしました" };
  emit(cancelled);
  return cancelled;
}

type FrameRequest = { input: string; timestamp: number; crop: ExportRequest["crop"]; pngCompression: number };
async function frameBlob(request: FrameRequest, overlay: OverlaySettings | null) {
  const { file, records } = source(request.input);
  const bytes = await (await media()).renderFrame(file, request.timestamp, request.crop, overlay, records, request.pngCompression);
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}
export async function copyCurrentFrame(request: FrameRequest, overlay: OverlaySettings | null) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("このブラウザでは画像コピーを利用できません。「現在PNG」を使って保存してください。");
  // PromiseをClipboardItemへ渡し、クリック時のユーザー操作権限を維持する。
  await navigator.clipboard.write([new ClipboardItem({ "image/png": frameBlob(request, overlay) })]);
}
export async function downloadCurrentFrame(request: FrameRequest, overlay: OverlaySettings | null) {
  const name = getSourceName(request.input);
  const blob = await frameBlob(request, overlay);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url;
  a.download = `${name.replace(/\.[^.]+$/, "")}_${request.timestamp.toFixed(3)}.png`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
