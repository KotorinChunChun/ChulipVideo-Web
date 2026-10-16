import { invoke } from "@tauri-apps/api/core";

export type GlobalConfig = Record<string, unknown> & {
  last_video_path: string;
  resolution_presets: Record<string, [number, number]>;
  selected_ratio: string;
  png_compression: number;
  check_prev_next: boolean;
  check_duplicate: boolean;
  play_speed: number;
  restore_last_video: boolean;
  seek_step: string;
  play_range: boolean;
  play_loop: boolean;
  play_pingpong: boolean;
  show_trajectory: boolean;
  show_subtitle: boolean;
  embed_overlay: boolean;
  aspect_options: string[];
  open_output_directory: boolean;
  confirm_overwrite: boolean;
  video_output_directory: string;
  image_output_directory: string;
};

export type VideoSettings = Record<string, unknown> & {
  video_file: string; crop_rect: { x1: number; y1: number; x2: number; y2: number } | null;
  start_time: number; end_time: number; current_time: number; allow_oversize: boolean; png_compression: number;
};
export type VideoMetadata = { path: string; duration: number; width: number; height: number; fps: number; frameCount: number | null; formatName: string; codecName: string };
export type WindowTarget = { hwnd: number; pid: number; title: string };
export type WindowGeometry = { left: number; top: number; width: number; height: number };
export type WindowInfo = { target: WindowTarget; processName: string; geometry: WindowGeometry | null; maximized: boolean; canMaximize: boolean };
export type MonitorInfo = { index: number; geometry: WindowGeometry; primary: boolean };
export type RecordingResult = { outputVideo: string; inputTsv: string | null; inputRecords: number };
export type InputRecord = { timestamp: number; frame: number; x: number; y: number; click: string; keys: string };
export type OverlaySettings = { showPointer: boolean; pointerSize: number; pointerColor: string; pointerOutlineColor: string; showClickRipple: boolean; rippleDuration: number; showSubtitles: boolean; subtitleFadeDuration: number; subtitleMaxStack: number; subtitleFontSize: number; subtitleForeground: string; subtitleBackground: string };
export type ShortcutRow = { key: string; recordEnabled: boolean; playEnabled: boolean };
export type ExportRequest = {
  input: string; output: string; format: "png-sequence" | "mp4" | "gif"; start: number; end: number;
  crop: { x: number; y: number; width: number; height: number } | null; fps: number | null; quality: number; pngCompression: number;
};
export type ExportJobState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type ExportJob = { id: string; state: ExportJobState; format: ExportRequest["format"]; output: string; progress: number; message: string };

export const loadGlobalConfig = () => invoke<{ path: string; value: GlobalConfig }>("load_global_config");
export const saveGlobalConfig = (value: GlobalConfig) => invoke<string>("save_global_config", { value });
export const loadVideoSettings = (video: string) => invoke<{ path: string; value: VideoSettings }>("load_video_settings", { video });
export const saveVideoSettings = (video: string, value: VideoSettings) => invoke<string>("save_video_settings", { video, value });
export const openVideoDialog = () => invoke<string | null>("open_video_dialog");
export const probeVideo = (path: string) => invoke<VideoMetadata>("probe_video", { path });
export const extractPreview = (path: string, timestamp: number) => invoke<number[]>("extract_preview", { path, timestamp });
export const loadInputHistory = (video: string) => invoke<InputRecord[]>("load_input_history", { video });
export const listWindows = (filter = "") => invoke<WindowInfo[]>("list_windows", { filter });
export const listMonitors = () => invoke<MonitorInfo[]>("list_monitors");
export const applyWindowGeometry = (target: WindowTarget, geometry: WindowGeometry, maximized = false) => invoke<WindowInfo>("apply_window_geometry", { target, geometry, maximized });
export const defaultRecordingDirectory = () => invoke<string>("default_recording_directory");
export const listRecordings = (directory: string) => invoke<string[]>("list_recordings", { directory });
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });

export async function startRecording(options: {
  region: WindowGeometry; outputVideo: string; inputTsv: string | null; fps: number; quality: number;
  drawCursor: boolean; maximumDurationSeconds: number | null; target: WindowTarget | null;
}) {
  const { target, region, ...recording } = options;
  return invoke<void>("start_recording", {
    command: { target, recording: { ...recording, region: { left: region.left, top: region.top, width: region.width, height: region.height } } },
  });
}
export const recordingStatus = () => invoke<{ active: boolean }>("recording_status");
export const stopRecording = () => invoke<RecordingResult>("stop_recording");

export const exportMedia = (request: ExportRequest, overlay: OverlaySettings | null) => invoke<string>("export_media", { request, overlay });
export const startExportJob = (request: ExportRequest, overlay: OverlaySettings | null) => invoke<ExportJob>("start_export_job", { request, overlay });
export const getExportJob = (id: string) => invoke<ExportJob>("get_export_job", { id });
export const listExportJobs = () => invoke<ExportJob[]>("list_export_jobs");
export const cancelExportJob = (id: string) => invoke<ExportJob>("cancel_export_job", { id });
export const copyCurrentFrame = (request: { input: string; timestamp: number; crop: ExportRequest["crop"]; pngCompression: number }, overlay: OverlaySettings | null) => invoke<void>("copy_current_frame", { request, overlay });

export async function loadShortcutRows() {
  const stored = await invoke<{ path: string; value: string }>("load_shortcuts");
  return { path: stored.path, rows: parseShortcutTsv(stored.value) };
}
export function saveShortcutRows(rows: ShortcutRow[]) { return invoke<string>("save_shortcuts", { value: generateShortcutTsv(rows) }); }
export function parseShortcutTsv(value: string): ShortcutRow[] {
  return value.split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const [key, record, play] = line.split("\t");
    return { key, recordEnabled: record === "1", playEnabled: play === "1" };
  });
}
export function generateShortcutTsv(rows: ShortcutRow[]) {
  return `Key\tRecordEnabled\tPlayEnabled\r\n${rows.map((row) => `${row.key}\t${Number(row.recordEnabled)}\t${Number(row.playEnabled)}`).join("\r\n")}\r\n`;
}

export function siblingPath(input: string, suffix: string, extension: string) {
  const separator = Math.max(input.lastIndexOf("\\"), input.lastIndexOf("/"));
  const dot = input.lastIndexOf("."); const baseEnd = dot > separator ? dot : input.length;
  return `${input.slice(0, baseEnd)}${suffix}.${extension}`;
}
