import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toggle, ToolButton } from "./components/MockControls";
import { AppSettingsScreen, OverlaySettingsScreen, ShortcutSettingsScreen } from "./screens/SettingsWindows";
import { RecorderScreen, WindowToolScreen } from "./screens/ToolWindows";
import { openMockWindow } from "./windowApi";
import { browserMode, listenExportJobs, listenOpenVideo, mediaUrl, cancelExportJob, copyCurrentFrame, ExportJob, extractPreview, GlobalConfig, InputRecord, listExportJobs, loadGlobalConfig, loadInputHistory, loadVideoSettings, openVideoDialog, OverlaySettings, pathExists, probeVideo, revealPath, saveGlobalConfig, saveVideoSettings, siblingPath, startExportJob, VideoMetadata, VideoSettings } from "./editorApi";
import { discardVideo, downloadCurrentFrame, getDownload, getSourceName, preparePlayback, registerVideo, retainVideo, selectInputHistory } from "./browser/api";
import { BrowserSettingsDialog } from "./browser/BrowserSettingsDialog";
import { buildSubtitleIntervals, getActiveSubtitleLines } from "./browser/overlay";
import { normalizeBrowserCrop } from "./browser/crop";
import "./browser/editor.css";

function TimeEditor({
  label,
  value,
  tone,
  onStep,
}: {
  label: string;
  value: string;
  tone: "green" | "black" | "red";
  onStep?: (seconds: number) => void;
}) {
  return (
    <div className={`time-editor time-${tone}`}>
      <strong>{label}</strong>
      <div className="time-editor-row">
        <button type="button" onClick={() => onStep?.(-1)}>-1s</button>
        <input aria-label={label} value={value} readOnly />
        <button type="button" onClick={() => onStep?.(1)}>+1s</button>
      </div>
    </div>
  );
}

type Crop = { x: number; y: number; width: number; height: number };
type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
function inputLabel(record: InputRecord | null) { if (!record) return ""; const clicks = record.click.split(",").filter((value) => value && value !== "None").map((value) => ({ "L-Click": "左クリック", "R-Click": "右クリック", "M-Click": "中央クリック", "Wheel-Up": "ホイール上", "Wheel-Down": "ホイール下" }[value] ?? value)); const keys = record.keys.split(",").filter((value) => value && value !== "None"); return [...keys, ...clicks].join(" + "); }
function VideoMock({ previewUrl, videoUrl, videoRef, onTimeUpdate, onPlaybackError, crop, metadata, input, showPointer, showSubtitle, positionLocked, sizeLocked, onCropStart, onCropChange, overlay, subtitleLines, ripples }: { previewUrl: string | null; videoUrl: string | null; videoRef: React.RefObject<HTMLVideoElement | null>; onTimeUpdate: () => void; onPlaybackError: (video: HTMLVideoElement) => void; crop: Crop | null; metadata: VideoMetadata | null; input: InputRecord | null; showPointer: boolean; showSubtitle: boolean; positionLocked: boolean; sizeLocked: boolean; onCropStart: () => void; onCropChange: (crop: Crop) => void; overlay: OverlaySettings | null; subtitleLines: string[]; ripples: InputRecord[] }) {
  const columns = useMemo(() => ["A", "B", "C", "D", "E", "F"], []);
  const rows = useMemo(() => Array.from({ length: 18 }, (_, index) => index + 1), []);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: "create" | "move" | "resize"; handle?: CropHandle; start: { x: number; y: number }; initial: Crop } | null>(null);
  const videoPoint = (clientX: number, clientY: number) => {
    const element = stageRef.current;
    if (!element || !metadata) return null;
    const rect = element.querySelector(".video-content")?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (clientX - rect.left) * metadata.width / rect.width, y: (clientY - rect.top) * metadata.height / rect.height };
  };
  const beginCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!crop || !metadata || event.button !== 0) return;
    const point = videoPoint(event.clientX, event.clientY); if (!point) return;
    const handle = (event.target as HTMLElement).dataset.handle as CropHandle | undefined;
    const inside = point.x >= crop.x && point.x <= crop.x + crop.width && point.y >= crop.y && point.y <= crop.y + crop.height;
    if (handle && !sizeLocked) dragRef.current = { mode: "resize", handle, start: point, initial: crop };
    else if (inside && !positionLocked) dragRef.current = { mode: "move", start: point, initial: crop };
    else if (!positionLocked && !sizeLocked) dragRef.current = { mode: "create", start: point, initial: { x: point.x, y: point.y, width: 2, height: 2 } };
    else return;
    onCropStart();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const dragCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current; if (!drag) return;
    const point = videoPoint(event.clientX, event.clientY); if (!point) return;
    const dx = point.x - drag.start.x; const dy = point.y - drag.start.y;
    if (drag.mode === "move") onCropChange({ ...drag.initial, x: drag.initial.x + dx, y: drag.initial.y + dy });
    else if (drag.mode === "create") onCropChange({ x: Math.min(drag.start.x, point.x), y: Math.min(drag.start.y, point.y), width: Math.abs(point.x - drag.start.x), height: Math.abs(point.y - drag.start.y) });
    else {
      let left = drag.initial.x, top = drag.initial.y, right = left + drag.initial.width, bottom = top + drag.initial.height;
      if (drag.handle?.includes("w")) left += dx;
      if (drag.handle?.includes("e")) right += dx;
      if (drag.handle?.includes("n")) top += dy;
      if (drag.handle?.includes("s")) bottom += dy;
      if (right < left) [left, right] = [right, left];
      if (bottom < top) [top, bottom] = [bottom, top];
      onCropChange({ x: left, y: top, width: right - left, height: bottom - top });
    }
  };

  return (
    <div ref={stageRef} className="video-stage" aria-label="映像プレビュー" onPointerDown={beginCrop} onPointerMove={dragCrop} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
      {(videoUrl || previewUrl) && metadata && <div className="video-content" role="group" aria-label="動画プレビュー" style={{ aspectRatio: `${metadata.width} / ${metadata.height}` }}>
        {videoUrl && <video ref={videoRef} className="real-video-preview" aria-hidden="true" playsInline src={videoUrl} onTimeUpdate={onTimeUpdate} onEnded={onTimeUpdate} onError={(event) => onPlaybackError(event.currentTarget)} />}
        {!videoUrl && previewUrl && <img className="real-video-preview" src={previewUrl} alt="選択した動画のプレビュー" />}
        {crop && <div className="crop-rectangle real-crop" style={{ left: `${crop.x / metadata.width * 100}%`, top: `${crop.y / metadata.height * 100}%`, width: `${crop.width / metadata.width * 100}%`, height: `${crop.height / metadata.height * 100}%` }}>{(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as CropHandle[]).map((handle) => <i key={handle} className={`handle handle-${handle}`} data-handle={handle} />)}</div>}
        {!browserMode && input && showPointer && <span className="live-pointer" style={{ left: `${input.x / metadata.width * 100}%`, top: `${input.y / metadata.height * 100}%` }}>➤</span>}
        {!browserMode && showSubtitle && inputLabel(input) && <span className="live-input-subtitle">{inputLabel(input)}</span>}
        {browserMode && overlay && <svg className="browser-operation-overlay" viewBox={`0 0 ${metadata.width} ${metadata.height}`} aria-hidden="true">
          {overlay.showClickRipple && showPointer && ripples.map((record, index) => <circle key={index} cx={record.x} cy={record.y} r="20" fill="none" stroke={overlay.pointerOutlineColor} strokeWidth="3" opacity="0.85" />)}
          {input && showPointer && <path d="M0 0 L0 28 L7 21 L13 34 L18 31 L12 18 L23 18 Z" transform={`translate(${input.x} ${input.y}) scale(${overlay.pointerSize / 36})`} fill={overlay.pointerColor} stroke={overlay.pointerOutlineColor} strokeWidth="2" />}
          {showSubtitle && subtitleLines.map((line, index) => {
            const fontSize = overlay.subtitleFontSize;
            const x = (crop?.x ?? 0) + (crop?.width ?? metadata.width) / 2;
            const y = (crop?.y ?? 0) + (crop?.height ?? metadata.height) - 20 - (subtitleLines.length - index - 1) * fontSize * 1.2;
            return <text key={index} x={x} y={y} textAnchor="middle" fill={overlay.subtitleForeground} stroke={overlay.subtitleBackground} strokeWidth="4" paintOrder="stroke" fontSize={fontSize}>{line}</text>;
          })}
        </svg>}
      </div>}
      {!videoUrl && !previewUrl && browserMode && <div className="browser-empty"><strong>ChulipVideo Web</strong><span>動画を開くか、この画面へドロップしてください</span><small>動画は端末内で処理します。最初の読み込み時に動画処理エンジンを準備します。</small></div>}
      {!videoUrl && !previewUrl && !browserMode && <>
      <div className="letterbox" />
      <div className="sheet-scene">
        <div className="sheet-corner" />
        <div className="column-headings">
          {columns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
        <div className="row-headings">
          {rows.map((row) => (
            <span key={row}>{row}</span>
          ))}
        </div>
        <div className="sheet-grid" />
        <div className="active-cell" />
        <div className="crop-rectangle">
          <i className="handle top-left" />
          <i className="handle top-right" />
          <i className="handle bottom-left" />
          <i className="handle bottom-right" />
        </div>
        <div className="pointer" aria-hidden="true">➤</div>
        <div className="input-stack" aria-hidden="true">
          <span>Right</span>
          <span>Up</span>
          <span>Left</span>
        </div>
      </div>
      <div className="letterbox" />
      <div className="mock-note">UI MOCK</div>
      </>}
    </div>
  );
}

function MainEditor() {
  const [mobilePanel, setMobilePanel] = useState("trim");
  const [playing, setPlaying] = useState(false);
  const [rangePlay, setRangePlay] = useState(false);
  const [loop, setLoop] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showPointer, setShowPointer] = useState(true);
  const [showSubtitle, setShowSubtitle] = useState(true);
  const [oversize, setOversize] = useState(false);
  const [ratio, setRatio] = useState("未指定");
  const [videoPath, setVideoPath] = useState("");
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [videoSettings, setVideoSettingsState] = useState<VideoSettings | null>(null);
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("動画を選択してください");
  const [currentTime, setCurrentTime] = useState(0);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [undoCrops, setUndoCrops] = useState<Crop[]>([]);
  const [redoCrops, setRedoCrops] = useState<Crop[]>([]);
  const [positionLocked, setPositionLocked] = useState(false);
  const [sizeLocked, setSizeLocked] = useState(false);
  const [inputRecords, setInputRecords] = useState<InputRecord[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const configRef = useRef<GlobalConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [frameBusy, setFrameBusy] = useState(false);
  const [browserDialog, setBrowserDialog] = useState<"app" | "overlay" | "help" | null>(null);
  const loadingRef = useRef(false);
  const playIntent = useRef(false);
  const videoPathRef = useRef("");
  videoPathRef.current = videoPath;

  const openVideo = async (path: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true; setLoading(true); playIntent.current = false; videoRef.current?.pause(); setPlaying(false);
    setStatus(browserMode ? "動画を読み込んでいます…（初回は処理エンジンを準備します）" : "動画を読み込んでいます…");
    try {
      const [info, settings, bytes, records] = await Promise.all([probeVideo(path), loadVideoSettings(path), extractPreview(path, 0), loadInputHistory(path)]);
      if (browserMode) await preparePlayback(path, setStatus);
      const nextUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); previewUrlRef.current = nextUrl; return nextUrl; });
      const clampTime = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(info.duration, value)) : 0;
      const start = clampTime(settings.value.start_time);
      const resolvedSettings = { ...settings.value, video_file: path, start_time: start, current_time: clampTime(settings.value.current_time), end_time: settings.value.end_time > start ? clampTime(settings.value.end_time) : info.duration };
      setVideoPath(path); setMetadata(info); setVideoSettingsState(resolvedSettings); setStatus("動画を読み込みました");
      setCurrentTime(resolvedSettings.current_time || 0); setOversize(resolvedSettings.allow_oversize);
      const storedCrop = resolvedSettings.crop_rect;
      const saved = storedCrop && Object.values(storedCrop).every(Number.isFinite) && storedCrop.x2 > storedCrop.x1 && storedCrop.y2 > storedCrop.y1 ? storedCrop : null;
      setCrop(saved ? { x: saved.x1, y: saved.y1, width: saved.x2 - saved.x1, height: saved.y2 - saved.y1 } : { x: 0, y: 0, width: info.width, height: info.height });
      setUndoCrops([]); setRedoCrops([]);
      setInputRecords(records);
      setConfig((old) => old ? { ...old, last_video_path: path } : old);
      setLoadRevision((value) => value + 1);
    } catch (error) { if (browserMode && path !== videoPathRef.current) discardVideo(path); setStatus(String(error)); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  useEffect(() => {
    if (!browserMode || !videoPath) return;
    retainVideo(videoPath);
    const video = videoRef.current;
    if (!video) return;
    const restoreTime = Math.max(0, videoSettings?.current_time ?? 0);
    const restore = () => { video.currentTime = Math.min(restoreTime, Number.isFinite(video.duration) ? video.duration : restoreTime); };
    const syncPlaying = () => setPlaying(!video.paused && !video.ended);
    video.addEventListener("loadedmetadata", restore);
    video.addEventListener("play", syncPlaying); video.addEventListener("pause", syncPlaying); video.addEventListener("ended", syncPlaying);
    if (video.readyState >= 1) restore();
    return () => { video.removeEventListener("loadedmetadata", restore); video.removeEventListener("play", syncPlaying); video.removeEventListener("pause", syncPlaying); video.removeEventListener("ended", syncPlaying); };
  }, [videoPath, loadRevision]);
  useEffect(() => {
    loadGlobalConfig().then(({ value }) => {
      setConfig(value); configRef.current = value; setRangePlay(value.play_range); setLoop(value.play_loop); setPlaybackSpeed(value.play_speed);
      setShowPointer(value.show_trajectory); setShowSubtitle(value.show_subtitle); setRatio(value.selected_ratio);
      if (value.restore_last_video && value.last_video_path) void openVideo(value.last_video_path);
    }).catch((error) => setStatus(String(error)));
    return () => { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); };
  }, []);
  useEffect(() => {
    let disposed = false;
    let stopJobListener: (() => void) | undefined;
    let stopOpenListener: (() => void) | undefined;
    const upsertJob = (job: ExportJob) => setExportJobs((jobs) => [job, ...jobs.filter((value) => value.id !== job.id)].slice(0, 20));
    void listExportJobs().then((jobs) => { if (!disposed) setExportJobs(jobs); }).catch(() => undefined);
    void listenExportJobs((job) => {
      if (!disposed) {
        upsertJob(job);
        if (job.state === "completed") { setStatus(browserMode ? `生成しました: ${job.output} — ダウンロードから保存してください` : `保存しました: ${job.output}`); if (configRef.current?.open_output_directory) void revealPath(job.output); }
        else if (job.state === "failed") setStatus(job.message);
        else if (job.state === "cancelled") setStatus("出力をキャンセルしました");
      }
    }).then((unlisten) => { if (disposed) unlisten(); else stopJobListener = unlisten; });
    void listenOpenVideo((path) => { if (!disposed && path) void openVideo(path); })
      .then((unlisten) => { if (disposed) unlisten(); else stopOpenListener = unlisten; });
    return () => { disposed = true; stopJobListener?.(); stopOpenListener?.(); };
  }, []);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = playbackSpeed; }, [playbackSpeed, videoPath]);
  const selectVideo = async () => { try { if (loadingRef.current) return; const path = await openVideoDialog(); if (path) await openVideo(path); } catch (error) { setStatus(String(error)); } };
  const openSettings = (kind: "app" | "overlay" | "help") => {
    if (browserMode) { playIntent.current = false; videoRef.current?.pause(); setBrowserDialog(kind); }
    else void openMockWindow(kind === "app" ? "app-settings" : kind === "overlay" ? "overlay-settings" : "shortcut-settings");
  };
  const loadTsv = async () => {
    if (!videoPath || loadingRef.current) return;
    loadingRef.current = true; setLoading(true);
    try { const records = await selectInputHistory(videoPath); if (records) { setInputRecords(records); setStatus(`操作履歴を${records.length}件読み込みました`); } }
    catch (error) { setStatus(String(error)); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  const saveSettings = async () => {
    try {
      if (config) await saveGlobalConfig({ ...config, last_video_path: videoPath, play_speed: playbackSpeed, play_range: rangePlay, play_loop: loop, play_pingpong: false, show_trajectory: showPointer, show_subtitle: showSubtitle, selected_ratio: ratio });
      if (videoPath && videoSettings) await saveVideoSettings(videoPath, { ...videoSettings, current_time: currentTime });
      setStatus("設定を保存しました");
    } catch (error) { setStatus(String(error)); }
  };
  const currentOverlay = (): OverlaySettings | null => showPointer || showSubtitle ? { showPointer, pointerSize: Number(config?.overlay_pointer_size ?? 36), pointerColor: String(config?.overlay_pointer_color ?? "#ffffff"), pointerOutlineColor: String(config?.overlay_pointer_outline ?? "#111111"), showClickRipple: config?.overlay_ripple !== false, rippleDuration: Number(config?.overlay_ripple_duration ?? 0.5), showSubtitles: showSubtitle, subtitleFadeDuration: Number(config?.overlay_subtitle_duration ?? 1), subtitleMaxStack: Number(config?.overlay_subtitle_stack ?? 3), subtitleFontSize: Number(config?.overlay_subtitle_font_size ?? 30), subtitleForeground: String(config?.overlay_subtitle_color ?? "#202020"), subtitleBackground: String(config?.overlay_subtitle_background ?? "#ffffff") } : null;
  const outputPath = (format: "png-sequence" | "mp4" | "gif", suffix: string, extension: string) => {
    const sibling = siblingPath(browserMode ? getSourceName(videoPath) : videoPath, suffix, extension);
    const directory = format === "png-sequence" ? config?.image_output_directory : config?.video_output_directory;
    if (!directory?.trim()) return sibling;
    const filename = sibling.slice(Math.max(sibling.lastIndexOf("\\"), sibling.lastIndexOf("/")) + 1);
    return `${directory.replace(/[\\/]+$/, "")}\\${filename}`;
  };
  const runExport = async (format: "png-sequence" | "mp4" | "gif") => {
    if (!metadata || !videoPath) { setStatus("先に動画を選択してください"); return; }
    const extension = format === "mp4" ? "mp4" : format === "gif" ? "gif" : "png";
    const suffix = format === "png-sequence" ? "_frames_%06d" : format === "mp4" ? "_clip" : "_clip";
    setStatus("出力jobを登録しています…");
    try {
      const output = outputPath(format, suffix, extension);
      if (config?.confirm_overwrite && await pathExists(output) && !window.confirm(`既存の出力を上書きしますか？\n${output}`)) { setStatus("出力を中止しました"); return; }
      const job = await startExportJob({ input: videoPath, output, format, start: videoSettings?.start_time ?? 0, end: videoSettings?.end_time || metadata.duration, crop, fps: format === "gif" ? 15 : null, quality: 80, pngCompression: config?.png_compression ?? 3 }, currentOverlay()); setExportJobs((jobs) => [job, ...jobs.filter((value) => value.id !== job.id)]); setStatus(`出力jobを開始しました: ${job.id}`);
    }
    catch (error) { setStatus(String(error)); }
  };
  const copyPreview = async () => {
    if (!videoPath || !metadata) { setStatus("先に動画を選択してください"); return; }
    setFrameBusy(true); setStatus("現在位置の画像を生成しています…");
    try {
      await copyCurrentFrame({ input: videoPath, timestamp: currentTime, crop, pngCompression: config?.png_compression ?? 3 }, currentOverlay());
      setStatus("現在位置の最終合成画像をクリップボードへコピーしました");
    }
    catch (error) { setStatus(`クリップボードへコピーできません: ${String(error)}`); }
    finally { setFrameBusy(false); }
  };
  const saveCurrentPng = async () => {
    if (!videoPath || !metadata || frameBusy) return;
    setFrameBusy(true); setStatus("現在位置のPNGを生成しています…");
    try { await downloadCurrentFrame({ input: videoPath, timestamp: currentTime, crop, pngCompression: config?.png_compression ?? 3 }, currentOverlay()); setStatus("現在位置のPNGをダウンロードしました"); }
    catch (error) { setStatus(String(error)); }
    finally { setFrameBusy(false); }
  };
  const seek = (seconds: number) => { if (!videoRef.current || !metadata) return; const value = Math.max(0, Math.min(metadata.duration, seconds)); videoRef.current.currentTime = value; setCurrentTime(value); };
  const seekFromPointer = (event: React.PointerEvent<HTMLInputElement>) => {
    if (!metadata) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const inset = 10;
    seek(Math.max(0, Math.min(1, (event.clientX - rect.left - inset) / Math.max(1, rect.width - inset * 2))) * metadata.duration);
  };
  const beginTimelineDrag = (event: React.PointerEvent<HTMLInputElement>) => {
    if (!browserMode || !metadata || event.button !== 0) return;
    event.preventDefault();
    videoRef.current?.pause(); setPlaying(false); playIntent.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  };
  const moveTimelineDrag = (event: React.PointerEvent<HTMLInputElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event);
  };
  const endTimelineDrag = (event: React.PointerEvent<HTMLInputElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      if (event.type !== "pointercancel") seekFromPointer(event);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const togglePlayback = async () => {
    const video = videoRef.current; if (!video) { setStatus("先に動画を選択してください"); return; }
    if (video.paused) {
      const start = videoSettings?.start_time ?? 0; const end = videoSettings?.end_time || metadata?.duration || 0;
      if (rangePlay && (video.currentTime < start || video.currentTime >= end)) seek(start);
      video.playbackRate = playbackSpeed;
      try { playIntent.current = true; await video.play(); setPlaying(true); } catch { playIntent.current = false; setStatus("この動画形式をブラウザで再生できません。MP4として書き出してから開き直してください。"); }
    } else { playIntent.current = false; video.pause(); setPlaying(false); }
  };
  const updatePlaybackTime = () => {
    const video = videoRef.current; if (!video) return;
    const start = rangePlay ? videoSettings?.start_time ?? 0 : 0;
    const end = rangePlay ? videoSettings?.end_time || metadata?.duration || 0 : metadata?.duration || 0;
    if (end > 0 && video.currentTime >= end) { if (loop) { video.currentTime = start; if (!video.paused || (browserMode && playIntent.current)) void video.play().catch(() => { playIntent.current = false; setPlaying(false); }); } else { playIntent.current = false; video.pause(); setPlaying(false); } }
    setCurrentTime(video.currentTime);
  };
  const applyCrop = (next: Crop, record = true) => {
    if (!metadata || !crop) return;
    let value: Crop;
    if (browserMode) value = normalizeBrowserCrop(next, crop, metadata, ratio, oversize);
    else {
      let adjusted = next;
      if (ratio !== "未指定" && (Math.abs(next.width - crop.width) > 0.1 || Math.abs(next.height - crop.height) > 0.1)) {
        const [rw, rh] = ratio.split(":").map(Number);
        if (rw > 0 && rh > 0) {
          const byWidth = Math.abs(next.width - crop.width) >= Math.abs(next.height - crop.height);
          adjusted = byWidth ? { ...next, height: next.width * rh / rw } : { ...next, width: next.height * rw / rh };
        }
      }
      value = { ...adjusted, width: Math.max(2, Math.round(adjusted.width)), height: Math.max(2, Math.round(adjusted.height)), x: Math.round(adjusted.x), y: Math.round(adjusted.y) };
      if (!oversize) { value.x = Math.max(0, Math.min(metadata.width - 2, value.x)); value.y = Math.max(0, Math.min(metadata.height - 2, value.y)); value.width = Math.min(value.width, metadata.width - value.x); value.height = Math.min(value.height, metadata.height - value.y); }
    }
    if (record) { setUndoCrops((values) => [...values.slice(-49), crop]); setRedoCrops([]); }
    setCrop(value);
    setVideoSettingsState((settings) => settings ? { ...settings, crop_rect: { x1: value.x, y1: value.y, x2: value.x + value.width, y2: value.y + value.height } } : settings);
  };
  const restoreCrop = (value: Crop) => {
    if (!browserMode) { applyCrop(value, false); return; }
    const outside = !!metadata && (value.x < 0 || value.y < 0 || value.x + value.width > metadata.width || value.y + value.height > metadata.height);
    setCrop(value); if (outside) setOversize(true);
    setVideoSettingsState((settings) => settings ? { ...settings, allow_oversize: outside || oversize, crop_rect: { x1: value.x, y1: value.y, x2: value.x + value.width, y2: value.y + value.height } } : settings);
  };
  const undoCrop = () => { const previous = undoCrops.at(-1); if (!previous || !crop) return; setUndoCrops((values) => values.slice(0, -1)); setRedoCrops((values) => [...values, crop]); restoreCrop(previous); };
  const redoCrop = () => { const next = redoCrops.at(-1); if (!next || !crop) return; setRedoCrops((values) => values.slice(0, -1)); setUndoCrops((values) => [...values, crop]); restoreCrop(next); };
  const beginCropInteraction = () => { if (!crop) return; setUndoCrops((values) => [...values.slice(-49), crop]); setRedoCrops([]); };
  const updateCropValue = (key: keyof Crop, raw: string) => { if (!crop) return; if (positionLocked && (key === "x" || key === "y")) return; if (sizeLocked && (key === "width" || key === "height")) return; const value = Number(raw); if (!Number.isFinite(value)) return; const next = { ...crop, [key]: value }; if (ratio !== "未指定" && (key === "width" || key === "height")) { const [rw, rh] = ratio.split(":").map(Number); if (key === "width") next.height = Math.round(value * rh / rw); else next.width = Math.round(value * rw / rh); } applyCrop(next); };
  const currentInput = useMemo(() => { let low=0,high=inputRecords.length-1,result:InputRecord|null=null;while(low<=high){const middle=(low+high)>>1;if(inputRecords[middle].timestamp<=currentTime){result=inputRecords[middle];low=middle+1}else high=middle-1}return result;},[inputRecords,currentTime]);
  const activeOverlay = useMemo(() => currentOverlay(), [config, showPointer, showSubtitle]);
  const subtitleIntervals = useMemo(() => browserMode && activeOverlay ? buildSubtitleIntervals(inputRecords, activeOverlay) : [], [inputRecords, activeOverlay]);
  const subtitleLines = getActiveSubtitleLines(subtitleIntervals, currentTime);
  const ripples = useMemo(() => browserMode && activeOverlay?.showClickRipple ? inputRecords.filter((record) => record.timestamp <= currentTime && currentTime < record.timestamp + activeOverlay.rippleDuration && record.click && record.click !== "None") : [], [inputRecords, activeOverlay, currentTime]);
  const displayedInput = browserMode && currentInput === inputRecords.at(-1) && currentInput && currentTime >= currentInput.timestamp + 1 / 30 ? null : currentInput;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (browserDialog || loading) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea, button") || event.ctrlKey || event.metaKey || event.altKey) return;
      const frame = metadata?.fps ? 1 / metadata.fps : 1 / 30;
      const seekStep = config?.seek_step === "5秒" ? 5 : config?.seek_step === "1フレーム" ? frame : 1;
      if (event.code === "Space") { event.preventDefault(); void togglePlayback(); }
      else if (event.code === "ArrowLeft") { event.preventDefault(); seek(currentTime - seekStep); }
      else if (event.code === "ArrowRight") { event.preventDefault(); seek(currentTime + seekStep); }
      else if (event.code === "Home") { event.preventDefault(); seek(rangePlay ? videoSettings?.start_time ?? 0 : 0); }
      else if (event.code === "End") { event.preventDefault(); seek(rangePlay ? videoSettings?.end_time || metadata?.duration || 0 : metadata?.duration || 0); }
      else if (event.key.toLowerCase() === "i" && videoSettings) setVideoSettingsState({ ...videoSettings, start_time: Math.min(currentTime, videoSettings.end_time || metadata?.duration || currentTime) });
      else if (event.key.toLowerCase() === "o" && videoSettings) setVideoSettingsState({ ...videoSettings, end_time: Math.max(currentTime, videoSettings.start_time) });
      else if (event.key.toLowerCase() === "l") setLoop((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentTime, metadata, videoSettings, rangePlay, loop, playbackSpeed, config?.seek_step, browserDialog, loading]);

  const timeline = (
<div className="timeline">
            <input className="timeline-seek" aria-label="シーク" type="range" min="0" max={metadata?.duration ?? 0} step={metadata?.fps ? 1 / metadata.fps : 0.01} value={currentTime} disabled={!metadata} onPointerDown={beginTimelineDrag} onPointerMove={moveTimelineDrag} onPointerUp={endTimelineDrag} onPointerCancel={endTimelineDrag} onChange={(event) => seek(Number(event.target.value))} />
            <div className="timeline-track">
              <span className="start-pin" style={{ left: `${(videoSettings?.start_time ?? 0) / (metadata?.duration || 1) * 100}%` }} />
              <span className="timeline-progress" style={{ left: `${(videoSettings?.start_time ?? 0) / (metadata?.duration || 1) * 100}%`, width: `${Math.max(0, ((videoSettings?.end_time || metadata?.duration || 0) - (videoSettings?.start_time ?? 0)) / (metadata?.duration || 1) * 100)}%` }} />
              <span className="end-pin" style={{ left: `${(videoSettings?.end_time || metadata?.duration || 0) / (metadata?.duration || 1) * 100}%` }} />
            </div>
            <span className="timeline-label start-label">Start</span>
            <span className="timeline-label end-label">End</span>
          </div>
  );
  return (
    <main data-mobile-panel={mobilePanel} className={`app-shell${browserMode ? " browser-editor" : ""}`} onDragOver={(event) => { if (browserMode) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={(event) => { if (!browserMode) return; event.preventDefault(); if (loadingRef.current) return; const file = event.dataTransfer.files[0]; if (file) { try { void openVideo(registerVideo(file)); } catch (error) { setStatus(String(error)); } } }}>
      <header className="source-toolbar">
        <div className="toolbar-actions">
          {!browserMode && <ToolButton tone="record" onClick={() => openMockWindow("recorder")}>🎥 録画</ToolButton>}
          <ToolButton disabled={loading} onClick={() => void selectVideo()}>{browserMode ? "動画を開く" : "🎞 選択"}</ToolButton>
          {!browserMode && <ToolButton onClick={() => openMockWindow("window-tool")}>▣ 窓調整</ToolButton>}
          {browserMode && <ToolButton disabled={!videoPath || loading} onClick={() => void loadTsv()}>操作TSVを開く</ToolButton>}
        </div>
        <div className="source-path" title="選択中の動画ファイル">
          {videoPath ? browserMode ? getSourceName(videoPath) : videoPath : "動画が選択されていません"}
        </div>
        <div className="toolbar-actions toolbar-actions-right">
          {!browserMode && <ToolButton compact title="保存フォルダを開く" onClick={() => videoPath && revealPath(videoPath)}>📂</ToolButton>}
          {!browserMode && <ToolButton compact title="入力履歴TSVを表示" onClick={() => videoPath && revealPath(siblingPath(videoPath, "", "tsv"))}>📄</ToolButton>}
          <ToolButton compact title="動画設定" disabled={!config} onClick={() => openSettings("app")}>⚙</ToolButton>
          <ToolButton compact tone="warn" title="設定を再読込" disabled={loading || !videoPath} onClick={() => videoPath && openVideo(videoPath)}>↻</ToolButton>
          <ToolButton compact tone="save" title="設定を保存" onClick={() => void saveSettings()}>💾</ToolButton>
          <span className="media-info">{metadata ? `(${metadata.duration.toFixed(3)}s, ${metadata.width}×${metadata.height})` : "(-)"}</span>
          {!browserMode && <span className="media-metric">133%</span>}
          <span className="media-metric">{metadata ? `${metadata.fps.toFixed(2)} FPS` : "- FPS"}</span>
          <ToolButton compact tone="warn" title="ショートカット一覧" disabled={!config} onClick={() => openSettings("help")}>?</ToolButton>
        </div>
      </header>

      <VideoMock previewUrl={previewUrl} videoUrl={videoPath ? mediaUrl(videoPath) : null} videoRef={videoRef} onTimeUpdate={updatePlaybackTime} onPlaybackError={(video) => setStatus(`この動画形式はブラウザで再生できません。MP4へ書き出して開き直してください (コード: ${video.error?.code ?? 0})`)} crop={crop} metadata={metadata} input={displayedInput} showPointer={showPointer} showSubtitle={showSubtitle} positionLocked={positionLocked} sizeLocked={sizeLocked} onCropStart={beginCropInteraction} onCropChange={(value) => applyCrop(value, false)} overlay={activeOverlay} subtitleLines={subtitleLines} ripples={ripples} />
      <div className="logic-status" role="status">{status}</div>

      <section className="control-dock">
        <div className="transport-row">
          <div className="transport-buttons">
          <ToolButton compact onClick={() => seek(0)}>◀◀ 先頭</ToolButton>
          <ToolButton compact tone="start" onClick={() => seek(videoSettings?.start_time ?? 0)}>◀ 開始位置</ToolButton>
          <ToolButton compact tone="play" onClick={() => void togglePlayback()}>
            {playing ? "■ 停止" : "▲ 再生"}
          </ToolButton>
          <ToolButton compact tone="end" onClick={() => seek(videoSettings?.end_time || metadata?.duration || 0)}>終了位置 ▶</ToolButton>
          <ToolButton compact onClick={() => seek(metadata?.duration ?? 0)}>末尾 ▶▶</ToolButton>
          </div>
          <Toggle label="区間再生" checked={rangePlay} onChange={setRangePlay} />
          <Toggle label="ループ再生" checked={loop} onChange={setLoop} />
          {!browserMode && <Toggle label="往復再生（次版）" checked={false} disabled onChange={() => undefined} />}
          <label className="speed-control">
            再生速度:
            <input aria-label="再生速度" type="number" value={playbackSpeed} min="0.1" max="4" step="0.1" onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setPlaybackSpeed(Math.max(0.1, Math.min(4, value))); }} />
          </label>
        </div>

        {browserMode && timeline}
        {browserMode && <div className="mobile-panel-tabs" role="tablist" aria-label="編集操作">
          {[["trim", "時間"], ["crop", "切り抜き"], ["overlay", "字幕"], ["still", "画像保存"], ["video", "動画保存"]].map(([id, label]) => <button key={id} id={`mobile-tab-${id}`} type="button" role="tab" aria-selected={mobilePanel === id} aria-controls={`mobile-panel-${id}`} onClick={() => setMobilePanel(id)}>{label}</button>)}
        </div>}
        <div className="editing-panels">
        <fieldset id="mobile-panel-trim" className="panel trim-panel">
          <legend>トリミング範囲</legend>
          {!browserMode && timeline}
          <div className="time-grid">
            <TimeEditor label="▼ Start（開始）" value={new Date((videoSettings?.start_time ?? 0) * 1000).toISOString().slice(11, 23)} tone="green" onStep={(delta) => videoSettings && setVideoSettingsState({ ...videoSettings, start_time: Math.min(videoSettings.end_time || metadata?.duration || 0, Math.max(0, videoSettings.start_time + delta)) })} />
            <TimeEditor label="● Current（現在）" value={new Date(currentTime * 1000).toISOString().slice(11, 23)} tone="black" onStep={(delta) => seek(currentTime + delta)} />
            <TimeEditor label="▲ End（終了）" value={metadata ? new Date((videoSettings?.end_time || metadata.duration) * 1000).toISOString().slice(11, 23) : "00:00:00.000"} tone="red" onStep={(delta) => videoSettings && metadata && setVideoSettingsState({ ...videoSettings, end_time: Math.max(videoSettings.start_time, Math.min(metadata.duration, (videoSettings.end_time || metadata.duration) + delta)) })} />
          </div>
          {browserMode && <div className="browser-range-inputs">
            <label>開始 <input aria-label="開始秒" type="number" min="0" max={metadata?.duration ?? 0} step="0.001" value={videoSettings?.start_time ?? 0} disabled={!metadata || loading} onChange={(event) => { const value = Number(event.target.value); if (videoSettings && metadata && Number.isFinite(value)) setVideoSettingsState({ ...videoSettings, start_time: Math.min(videoSettings.end_time, Math.max(0, value)) }); }} /> 秒</label>
            <button type="button" disabled={!metadata} onClick={() => videoSettings && setVideoSettingsState({ ...videoSettings, start_time: Math.min(currentTime, videoSettings.end_time) })}>現在位置を開始に</button>
            <label>終了 <input aria-label="終了秒" type="number" min="0" max={metadata?.duration ?? 0} step="0.001" value={videoSettings?.end_time ?? 0} disabled={!metadata || loading} onChange={(event) => { const value = Number(event.target.value); if (videoSettings && metadata && Number.isFinite(value)) setVideoSettingsState({ ...videoSettings, end_time: Math.min(metadata.duration, Math.max(videoSettings.start_time, value)) }); }} /> 秒</label>
            <button type="button" disabled={!metadata} onClick={() => videoSettings && setVideoSettingsState({ ...videoSettings, end_time: Math.max(currentTime, videoSettings.start_time) })}>現在位置を終了に</button>
          </div>}
        </fieldset>

        <fieldset id="mobile-panel-crop" className="panel crop-panel">
          <legend>クロップ範囲</legend>
          <div className="crop-content">
            <div className="undo-group">
              <ToolButton tone="play" onClick={undoCrop}>↩</ToolButton>
              <ToolButton tone="play" onClick={redoCrop}>↪</ToolButton>
            </div>
            <Toggle label="枠外選択" checked={oversize} onChange={(value) => { setOversize(value); setVideoSettingsState((settings) => settings ? { ...settings, allow_oversize: value } : settings); }} />
            <div className="vertical-separator" />
            <span className="section-label">座標:</span>
            <ToolButton tone="start" onClick={() => setPositionLocked((value) => !value)}>{positionLocked ? "🔒" : "🔓"}</ToolButton>
            <div className="numeric-pair">
              <label>X:<input aria-label="クロップX" type="number" value={crop?.x ?? 0} disabled={positionLocked} onChange={(event) => updateCropValue("x", event.target.value)} /></label>
              <label>Y:<input aria-label="クロップY" type="number" value={crop?.y ?? 0} disabled={positionLocked} onChange={(event) => updateCropValue("y", event.target.value)} /></label>
            </div>
            <div className="vertical-separator" />
            <span className="section-label">解像度:</span>
            <ToolButton tone="start" onClick={() => setSizeLocked((value) => !value)}>{sizeLocked ? "🔒" : "🔓"}</ToolButton>
            <div className="select-pair">
              <select value={ratio} onChange={(event) => setRatio(event.target.value)}>
                <option>未指定</option>
                <option>16:9</option>
                <option>4:3</option>
                <option>1:1</option>
              </select>
              <select aria-label="解像度プリセット" value={selectedPreset} onChange={(event) => { const name = event.target.value; setSelectedPreset(name); const preset = config?.resolution_presets[name]; if (preset && crop) applyCrop({ ...crop, width: preset[0], height: preset[1] }); }}>
                <option value="">カスタム</option>
                {Object.entries(config?.resolution_presets ?? {}).map(([name, [width, height]]) => <option key={name} value={name}>{name}（{width}×{height}）</option>)}
              </select>
            </div>
            <div className="numeric-pair">
              <label>幅:<input aria-label="クロップ幅" type="number" value={crop?.width ?? 0} disabled={sizeLocked} onChange={(event) => updateCropValue("width", event.target.value)} /></label>
              <label>高:<input aria-label="クロップ高さ" type="number" value={crop?.height ?? 0} disabled={sizeLocked} onChange={(event) => updateCropValue("height", event.target.value)} /></label>
            </div>
            <div className="preset-actions">
              <button type="button" disabled={!crop || !config} onClick={() => { if (!crop || !config) return; const name = window.prompt("プリセット名", `${crop.width}×${crop.height}`)?.trim(); if (!name) return; setConfig({ ...config, resolution_presets: { ...config.resolution_presets, [name]: [crop.width, crop.height] } }); setSelectedPreset(name); setStatus(`プリセット「${name}」を追加しました。保存ボタンで設定へ保存できます`); }}>プリセット追加</button>
              <button type="button" disabled={!selectedPreset || !config} onClick={() => { if (!selectedPreset || !config || !window.confirm(`プリセット「${selectedPreset}」を削除しますか？`)) return; const presets = { ...config.resolution_presets }; delete presets[selectedPreset]; setConfig({ ...config, resolution_presets: presets }); setSelectedPreset(""); }}>プリセット削除</button>
            </div>
          </div>
        </fieldset>

        <fieldset className="panel export-panel">
          <legend>エクスポート</legend>
          <div className="export-grid">
            <section id="mobile-panel-overlay" className="export-section overlay-options">
              <h2>操作の軌跡</h2>
              <div className="overlay-toggle-list">
                <Toggle label="マウスポインタを表示" checked={showPointer} onChange={setShowPointer} />
                <Toggle label="マウス・キー入力字幕を表示" checked={showSubtitle} onChange={setShowSubtitle} />
              </div>
              {browserMode && <small>{inputRecords.length ? `操作履歴: ${inputRecords.length}件` : "操作情報はTSVを開くと利用できます"}</small>}
              <ToolButton tone="warn" disabled={!config} onClick={() => openSettings("overlay")}>⚙ 詳細設定</ToolButton>
            </section>
            <section id="mobile-panel-still" className="export-section still-output">
              <h2>静止画出力</h2>
              <ToolButton tone="play" disabled={!metadata || loading || frameBusy} onClick={() => void copyPreview()}>📷 表示内容をCOPY</ToolButton>
              {browserMode && <ToolButton disabled={!metadata || loading || frameBusy} onClick={() => void saveCurrentPng()}>現在PNG保存</ToolButton>}
              <div className="export-options">
                {!browserMode && <Toggle label="前後不一致で除外（次版）" checked={false} disabled onChange={() => undefined} />}
                {!browserMode && <Toggle label="直前重複で除外（次版）" checked={false} disabled onChange={() => undefined} />}
                <label>PNG圧縮: <input type="number" min="0" max="9" value={config?.png_compression ?? 3} onChange={(event) => config && setConfig({ ...config, png_compression: Math.max(0, Math.min(9, Number(event.target.value))) })} /></label>
              </div>
              <ToolButton tone="end" disabled={!metadata || loading || exportJobs.some((job) => job.format === "png-sequence" && ["queued", "running", "cancelling"].includes(job.state))} onClick={() => void runExport("png-sequence")}>🖼 PNG連番保存</ToolButton>
            </section>
            <section id="mobile-panel-video" className="export-section video-output">
              <h2>動画出力</h2>
              <ToolButton tone="start" disabled={!metadata || loading || exportJobs.some((job) => job.format === "mp4" && ["queued", "running", "cancelling"].includes(job.state))} onClick={() => void runExport("mp4")}>🎞 MP4 動画保存</ToolButton>
              <ToolButton tone="warn" disabled={!metadata || loading || exportJobs.some((job) => job.format === "gif" && ["queued", "running", "cancelling"].includes(job.state))} onClick={() => void runExport("gif")}>🖼 GIF アニメ保存</ToolButton>
            </section>
          </div>
          {exportJobs.length > 0 && <div className="export-jobs" aria-label="出力job一覧">
            {exportJobs.slice(0, 5).map((job) => <div key={job.id} data-job-id={job.id} className={`export-job state-${job.state}`}>
              <span>{job.format}</span><progress max="1" value={job.progress} /><span>{Math.round(job.progress * 100)}% {job.message}</span>
              {browserMode && job.state === "completed" && getDownload(job.id) && <a href={getDownload(job.id)!.url} download={getDownload(job.id)!.filename}>ダウンロード</a>}
              {(job.state === "queued" || job.state === "running" || job.state === "cancelling") && <button type="button" disabled={job.state === "cancelling"} onClick={() => void cancelExportJob(job.id).then((next) => setExportJobs((jobs) => [next, ...jobs.filter((value) => value.id !== next.id)])).catch((error) => setStatus(String(error)))}>キャンセル</button>}
            </div>)}
          </div>}
        </fieldset>
        </div>
      </section>
      {browserMode && config && browserDialog && <BrowserSettingsDialog kind={browserDialog} config={{ ...config, play_speed: playbackSpeed, play_range: rangePlay, play_loop: loop, show_trajectory: showPointer, show_subtitle: showSubtitle }} onClose={() => setBrowserDialog(null)} onSave={async (value) => { await saveGlobalConfig(value); setConfig(value); configRef.current = value; setPlaybackSpeed(value.play_speed); setRangePlay(value.play_range); setLoop(value.play_loop); setShowPointer(value.show_trajectory); setShowSubtitle(value.show_subtitle); }} />}
    </main>
  );
}

function App() {
  if (browserMode) return <MainEditor />;
  const browserView = new URLSearchParams(window.location.search).get("view");
  let tauriView: string | null = null;
  try {
    const label = getCurrentWindow().label;
    tauriView = label === "main" ? null : label;
  } catch {
    // Browser preview has no Tauri window metadata and uses the query parameter.
  }
  const view = browserView ?? tauriView;
  if (view === "recorder") return <RecorderScreen />;
  if (view === "window-tool") return <WindowToolScreen />;
  if (view === "app-settings") return <AppSettingsScreen />;
  if (view === "overlay-settings") return <OverlaySettingsScreen />;
  if (view === "shortcut-settings") return <ShortcutSettingsScreen />;
  return <MainEditor />;
}

export default App;
