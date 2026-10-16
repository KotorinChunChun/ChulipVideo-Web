import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FauxDesktopPreview, FieldRow, Toggle, ToolButton } from "../components/MockControls";
import { applyWindowGeometry, defaultRecordingDirectory, listMonitors, listRecordings, listWindows, MonitorInfo, recordingStatus, revealPath, stopRecording, WindowGeometry, WindowInfo, WindowTarget } from "../tauriApi";
import { captureRegionPreview, chooseDirectory, closeAndEditRecording, listAudioDevices, renameRecording, startRecordingV3, trashRecording, type AudioDevice } from "../toolApi";
import { closeCurrentWindow, openMockWindow } from "../windowApi";

type TargetSelection = { desktop: boolean; target: WindowTarget | null; region: WindowGeometry };
const fallbackRegion: WindowGeometry = { left: 0, top: 0, width: 1280, height: 720 };

function RegionPreview({ region, compact = false }: { region: WindowGeometry; compact?: boolean }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let currentUrl = "";
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        try { if (!await getCurrentWindow().isVisible()) return; } catch { /* browser preview */ }
        const bytes = await captureRegionPreview(region);
        if (disposed) return;
        const nextUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = nextUrl;
        setUrl(nextUrl);
        setError("");
      } catch (value) {
        if (!disposed) setError(String(value));
      } finally { running = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [region.left, region.top, region.width, region.height]);
  return <div className={compact ? "real-tool-preview compact" : "real-tool-preview"}>
    {url ? <img src={url} alt="選択範囲の実プレビュー" /> : <FauxDesktopPreview compact={compact} />}
    {error && <small>{error}</small>}
  </div>;
}

function WindowTargetControls({ onOpenTool, onChange }: { onOpenTool?: () => void; onChange: (value: TargetSelection) => void }) {
  const [desktop, setDesktop] = useState(false);
  const [fit, setFit] = useState(true);
  const [filter, setFilter] = useState("");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selected, setSelected] = useState<WindowInfo | null>(null);
  const [region, setRegion] = useState(fallbackRegion);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [windowValues, monitorValues] = await Promise.all([listWindows(filter), listMonitors()]);
      setWindows(windowValues); setMonitors(monitorValues);
      const next = windowValues.find((item) => item.target.hwnd === selected?.target.hwnd) ?? windowValues[0] ?? null;
      setSelected(next); if (!desktop && next?.geometry) setRegion(next.geometry);
      if (desktop && monitorValues[0]) setRegion(monitorValues.find((item) => item.primary)?.geometry ?? monitorValues[0].geometry);
      setMessage(`${windowValues.length}件のウィンドウを取得`);
    } catch (error) { setMessage(String(error)); }
  }, [desktop, filter, selected?.target.hwnd]);
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { onChange({ desktop, target: desktop ? null : selected?.target ?? null, region }); }, [desktop, selected, region, onChange]);
  const chooseWindow = (raw: string) => { const next = windows.find((item) => String(item.target.hwnd) === raw) ?? null; setSelected(next); if (next?.geometry) setRegion(next.geometry); };
  const chooseDesktop = () => { setDesktop(true); const monitor = monitors.find((item) => item.primary) ?? monitors[0]; if (monitor) setRegion(monitor.geometry); };
  const sync = () => { if (selected?.geometry) setRegion(selected.geometry); };
  const apply = async (maximized = false) => {
    if (!selected) { setMessage("対象ウィンドウを選択してください"); return; }
    try { const updated = await applyWindowGeometry(selected.target, region, maximized); setSelected(updated); if (updated.geometry) setRegion(updated.geometry); setMessage("対象ウィンドウへ適用しました"); }
    catch (error) { setMessage(String(error)); }
  };
  const updateRegion = (key: keyof WindowGeometry, raw: string) => setRegion((current) => ({ ...current, [key]: Number(raw) || 0 }));
  return (
    <fieldset className="native-group target-group">
      <legend>録画対象</legend>
      <div className="inline-row">
        <label><input type="radio" checked={desktop} onChange={chooseDesktop} /> デスクトップ</label>
        <label><input type="radio" checked={!desktop} onChange={() => { setDesktop(false); sync(); }} /> ウィンドウ</label>
        <input className="grow" placeholder="ウィンドウ名を検索" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <select className="grow" value={selected ? String(selected.target.hwnd) : ""} disabled={desktop} onChange={(event) => chooseWindow(event.target.value)}>
          <option value="">選択してください</option>{windows.map((item) => <option key={`${item.target.hwnd}-${item.target.pid}`} value={String(item.target.hwnd)}>{item.processName} - {item.target.title}</option>)}
        </select>
        <button type="button" onClick={() => void refresh()}>更新</button>
      </div>
      <div className="inline-row target-values">
        <button type="button" disabled={desktop} onClick={() => void apply(true)}>最大化</button><button type="button" disabled={desktop} onClick={sync}>同期</button>
        {onOpenTool && <button type="button" onClick={onOpenTool}>位置を詳しく調整…</button>}
        {(["left", "top", "width", "height"] as (keyof WindowGeometry)[]).map((key) => <FieldRow key={key} label={{ left: "X", top: "Y", width: "幅", height: "高さ" }[key]}><input type="number" value={region[key]} onChange={(event) => updateRegion(key, event.target.value)} /></FieldRow>)}
        <button type="button" disabled={desktop} onClick={() => void apply(false)}>適用</button>
        <Toggle label="プレビューに合わせる" checked={fit} onChange={setFit} />
      </div>
      <small>{message}</small>
    </fieldset>
  );
}

function stamp() {
  const now = new Date(); const part = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}_${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}
function joinPath(directory: string, name: string) { return `${directory.replace(/[\\/]$/, "")}\\${name}`; }
function durationSeconds(value: string) { const parts = value.split(":").map(Number); return parts.length === 3 && parts.every(Number.isFinite) ? parts[0] * 3600 + parts[1] * 60 + parts[2] : null; }

export function RecorderScreen() {
  const [tab, setTab] = useState<"record" | "play">("record");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [frame, setFrame] = useState(true);
  const [tsv, setTsv] = useState(true);
  const [overlay, setOverlay] = useState(false);
  const [directory, setDirectory] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [target, setTarget] = useState<TargetSelection>({ desktop: false, target: null, region: fallbackRegion });
  const [fps, setFps] = useState(30); const [quality, setQuality] = useState(85); const [maximum, setMaximum] = useState("00:30:00");
  const [countdown, setCountdown] = useState(0); const [countdownRemaining, setCountdownRemaining] = useState<number | null>(null);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [systemAudio, setSystemAudio] = useState(false); const [systemDevice, setSystemDevice] = useState("");
  const [microphone, setMicrophone] = useState(false); const [microphoneDevice, setMicrophoneDevice] = useState("");
  const [message, setMessage] = useState("録画待機中");
  const countdownGeneration = useRef(0);
  const targetChanged = useCallback((value: TargetSelection) => setTarget(value), []);
  const refreshFiles = useCallback(async (path: string) => { try { const values = await listRecordings(path); setFiles(values); setSelectedFile((old) => values.includes(old) ? old : values[0] ?? ""); } catch (error) { setMessage(String(error)); } }, []);
  useEffect(() => { defaultRecordingDirectory().then((path) => { setDirectory(path); void refreshFiles(path); }).catch((error) => setMessage(String(error))); }, [refreshFiles]);
  useEffect(() => {
    listAudioDevices().then((devices) => {
      setAudioDevices(devices);
      setSystemDevice((old) => old || devices[0]?.id || "");
      setMicrophoneDevice((old) => old || devices[0]?.id || "");
    }).catch((error) => setMessage(`音声デバイスを取得できません: ${String(error)}`));
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(async () => {
      setElapsed((value) => value + 1);
      try { const value = await recordingStatus(); if (!value.active) { setRecording(false); setMessage("録画が完了しました"); void refreshFiles(directory); } }
      catch (error) { setMessage(String(error)); }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording, directory, refreshFiles]);
  const toggleRecording = async () => {
    try {
      if (recording) { const result = await stopRecording(); setRecording(false); setElapsed(0); setMessage(`録画を保存しました（入力 ${result.inputRecords}フレーム）`); await refreshFiles(directory); return; }
      if (countdownRemaining !== null) { countdownGeneration.current += 1; setCountdownRemaining(null); setMessage("開始カウントをキャンセルしました"); return; }
      if (!directory) throw new Error("保存先を指定してください");
      if (!target.desktop && !target.target) throw new Error("録画対象ウィンドウを選択してください");
      if (systemAudio && !systemDevice) throw new Error("システム音声のデバイスを選択してください");
      if (microphone && !microphoneDevice) throw new Error("マイク音声のデバイスを選択してください");
      const generation = ++countdownGeneration.current;
      for (let remaining = Math.max(0, Math.min(60, Math.trunc(countdown))); remaining > 0; remaining -= 1) {
        setCountdownRemaining(remaining); setMessage(`${remaining}秒後に録画を開始します`);
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (generation !== countdownGeneration.current) return;
      }
      setCountdownRemaining(null);
      const base = `ChulipVideo_${stamp()}`;
      await startRecordingV3({ region: target.region, target: target.target, outputVideo: joinPath(directory, `${base}.mp4`), inputTsv: tsv ? joinPath(directory, `${base}.tsv`) : null, fps, quality, drawCursor: true, showRegion: frame, maximumDurationSeconds: durationSeconds(maximum), systemAudioEnabled: systemAudio, systemAudioDevice: systemAudio ? systemDevice : null, microphoneEnabled: microphone, microphoneDevice: microphone ? microphoneDevice : null });
      setElapsed(0); setRecording(true); setMessage("録画中");
    } catch (error) { setMessage(String(error)); }
  };
  const selectDirectory = async () => { try { const path = await chooseDirectory(); if (path) { setDirectory(path); await refreshFiles(path); } } catch (error) { setMessage(String(error)); } };
  const renameSelected = async () => {
    if (!selectedFile) return;
    const current = selectedFile.split(/[\\/]/).pop() ?? "";
    const next = window.prompt("新しい録画ファイル名", current.replace(/\.[^.]+$/, ""));
    if (!next) return;
    try { const renamed = await renameRecording(selectedFile, next); await refreshFiles(directory); setSelectedFile(renamed); setMessage("動画と操作ログの名前を変更しました"); }
    catch (error) { setMessage(String(error)); }
  };
  const deleteSelected = async () => {
    if (!selectedFile || !window.confirm("選択した動画と対応する操作ログをごみ箱へ移動しますか？")) return;
    try { await trashRecording(selectedFile); await refreshFiles(directory); setMessage("動画と操作ログをごみ箱へ移動しました"); }
    catch (error) { setMessage(String(error)); }
  };
  const editSelected = async () => { if (!selectedFile) { setMessage("編集する録画を選択してください"); return; } try { await closeAndEditRecording(selectedFile); } catch (error) { setMessage(String(error)); } };
  const time = new Date(elapsed * 1000).toISOString().slice(11, 19);
  return (
    <main className="utility-shell recorder-shell">
      <aside className="recorder-sidebar">
        <fieldset className="native-group"><legend>保存設定</legend><div className="path-row"><input value={directory} onChange={(event) => setDirectory(event.target.value)} /><button type="button" onClick={() => void selectDirectory()}>…</button><button type="button" onClick={() => directory && revealPath(directory)}>開く</button></div></fieldset>
        <fieldset className="native-group file-list-group"><legend>録画済みファイル</legend>
          <select size={10} value={selectedFile} onChange={(event) => setSelectedFile(event.target.value)}>{files.map((file) => <option key={file} value={file}>{file.split(/[\\/]/).pop()}</option>)}</select>
          <div className="two-column-buttons"><button type="button" disabled={!selectedFile} onClick={() => void renameSelected()}>名前変更</button><button type="button" disabled={!selectedFile} onClick={() => void deleteSelected()}>削除</button></div>
          <button type="button" onClick={() => directory && revealPath(directory)}>保存フォルダを開く</button><button type="button" disabled={!selectedFile} onClick={() => selectedFile && revealPath(selectedFile.replace(/\.[^.]+$/, ".tsv"))}>操作ログを表示</button>
        </fieldset>
        <div className="recorder-sidebar-actions"><ToolButton tone="warn" onClick={() => openMockWindow("shortcut-settings")}>⌨ キー設定</ToolButton><ToolButton tone="play" disabled={!selectedFile} onClick={() => void editSelected()}>閉じて編集</ToolButton><ToolButton onClick={closeCurrentWindow}>閉じる</ToolButton></div>
      </aside>
      <section className="recorder-main">
        <nav className="native-tabs"><button className={tab === "record" ? "active" : ""} onClick={() => setTab("record")}>録画</button><button className={tab === "play" ? "active" : ""} onClick={() => setTab("play")}>再生</button></nav>
        {tab === "record" ? <>
          <WindowTargetControls onOpenTool={() => openMockWindow("window-tool")} onChange={targetChanged} /><RegionPreview region={target.region} />
          <fieldset className="native-group recording-options"><legend>録画設定</legend><div className="option-grid">
            <FieldRow label="形式"><select value="MP4" disabled><option>MP4</option></select></FieldRow><FieldRow label="FPS"><input type="number" min="1" max="120" value={fps} onChange={(event) => setFps(Number(event.target.value))} /></FieldRow>
            <FieldRow label="品質"><select value={quality} onChange={(event) => setQuality(Number(event.target.value))}><option value={90}>高品質</option><option value={70}>標準</option><option value={50}>軽量</option></select></FieldRow><FieldRow label="開始カウント"><input type="number" min="0" max="60" value={countdown} onChange={(event) => setCountdown(Number(event.target.value))} /></FieldRow><FieldRow label="最大時間"><input value={maximum} onChange={(event) => setMaximum(event.target.value)} /></FieldRow>
          </div><div className="inline-row wrapping"><Toggle label="録画範囲を枠表示" checked={frame} onChange={setFrame} /><Toggle label="操作をTSVへ保存" checked={tsv} onChange={setTsv} /><Toggle label="操作字幕を重ねてプレビュー" checked={overlay} onChange={setOverlay} /></div>
          <div className="audio-grid"><Toggle label="システム音声" checked={systemAudio} onChange={setSystemAudio} /><select disabled={!systemAudio || audioDevices.length === 0} value={systemDevice} onChange={(event) => setSystemDevice(event.target.value)}><option value="">録音可能なデバイスなし</option>{audioDevices.map((device) => <option key={`system-${device.id}`} value={device.id}>{device.name}</option>)}</select><Toggle label="マイク音声" checked={microphone} onChange={setMicrophone} /><select disabled={!microphone || audioDevices.length === 0} value={microphoneDevice} onChange={(event) => setMicrophoneDevice(event.target.value)}><option value="">録音可能なデバイスなし</option>{audioDevices.map((device) => <option key={`microphone-${device.id}`} value={device.id}>{device.name}</option>)}</select></div></fieldset>
          <footer className="recorder-footer"><span className={recording ? "record-status active" : "record-status"}>{recording ? `録画中 ${time}` : message}</span><ToolButton tone="record" className="primary-record" onClick={() => void toggleRecording()}>{recording ? "■ 録画停止" : countdownRemaining !== null ? "■ カウント中止" : "● 録画開始"}</ToolButton></footer>
        </> : <div className="playback-pane">{selectedFile ? <video className="recording-player" src={convertFileSrc(selectedFile)} controls /> : <FauxDesktopPreview />}<div className="playback-file">選択中: {selectedFile || "なし"}</div></div>}
      </section>
    </main>
  );
}

export function WindowToolScreen() {
  const [filter, setFilter] = useState(""); const [windows, setWindows] = useState<WindowInfo[]>([]); const [selected, setSelected] = useState<WindowInfo | null>(null);
  const [rect, setRect] = useState<WindowGeometry>(fallbackRegion); const [applied, setApplied] = useState<WindowGeometry>(fallbackRegion); const [previous, setPrevious] = useState<WindowGeometry>(fallbackRegion); const [outside, setOutside] = useState(false); const [message, setMessage] = useState("");
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]); const [canUndo, setCanUndo] = useState(false);
  const refresh = async () => { try { const [values, monitorValues] = await Promise.all([listWindows(filter), listMonitors()]); setWindows(values); setMonitors(monitorValues); const next = values.find((item) => item.target.hwnd === selected?.target.hwnd) ?? values[0] ?? null; setSelected(next); setCanUndo(false); if (next?.geometry) { setRect(next.geometry); setApplied(next.geometry); setPrevious(next.geometry); } setMessage(`${values.length}件取得`); } catch (error) { setMessage(String(error)); } };
  useEffect(() => { void refresh(); }, []);
  const choose = (value: string) => { const next = windows.find((item) => String(item.target.hwnd) === value) ?? null; setSelected(next); setCanUndo(false); if (next?.geometry) { setRect(next.geometry); setApplied(next.geometry); setPrevious(next.geometry); } };
  const update = (key: keyof WindowGeometry, value: string) => setRect((current) => ({ ...current, [key]: Number(value) || 0 }));
  const constrained = (value: WindowGeometry) => {
    if (outside || monitors.length === 0) return value;
    const left = Math.min(...monitors.map((item) => item.geometry.left)); const top = Math.min(...monitors.map((item) => item.geometry.top));
    const right = Math.max(...monitors.map((item) => item.geometry.left + item.geometry.width)); const bottom = Math.max(...monitors.map((item) => item.geometry.top + item.geometry.height));
    const width = Math.max(2, Math.min(value.width, right - left)); const height = Math.max(2, Math.min(value.height, bottom - top));
    return { left: Math.max(left, Math.min(value.left, right - width)), top: Math.max(top, Math.min(value.top, bottom - height)), width, height };
  };
  const apply = async () => { if (!selected) { setMessage("対象を選択してください"); return; } try { const value = constrained(rect); const result = await applyWindowGeometry(selected.target, value); setPrevious(applied); setCanUndo(true); setSelected(result); setRect(result.geometry ?? value); setApplied(result.geometry ?? value); setMessage("適用しました"); } catch (error) { setMessage(String(error)); } };
  const maximize = async () => { if (!selected) return; try { const result = await applyWindowGeometry(selected.target, rect, true); setPrevious(applied); setCanUndo(true); setSelected(result); if (result.geometry) { setRect(result.geometry); setApplied(result.geometry); } setMessage("最大化しました"); } catch (error) { setMessage(String(error)); } };
  const syncCurrent = async () => { if (!selected) return; try { const values = await listWindows(""); const next = values.find((item) => item.target.hwnd === selected.target.hwnd && item.target.pid === selected.target.pid); if (!next?.geometry) throw new Error("対象ウィンドウの現在位置を取得できません"); setSelected(next); setRect(next.geometry); setApplied(next.geometry); setMessage("現在位置と同期しました"); } catch (error) { setMessage(String(error)); } };
  const undo = async () => { if (!selected || !canUndo) return; try { const result = await applyWindowGeometry(selected.target, previous); setRect(result.geometry ?? previous); setApplied(result.geometry ?? previous); setSelected(result); setCanUndo(false); setMessage("直前の位置へ戻しました"); } catch (error) { setMessage(String(error)); } };
  return <main className="utility-shell window-tool-shell">
    <header className="window-tool-header"><strong>ChunapTool</strong><span>ウィンドウ位置調整ツール</span></header>
    <fieldset className="native-group"><legend>対象選択</legend><div className="inline-row"><input className="grow" placeholder="ウィンドウ名を検索" value={filter} onChange={(event) => setFilter(event.target.value)} /><select className="grow" value={selected ? String(selected.target.hwnd) : ""} onChange={(event) => choose(event.target.value)}><option value="">選択してください</option>{windows.map((item) => <option key={`${item.target.hwnd}-${item.target.pid}`} value={String(item.target.hwnd)}>{item.processName} - {item.target.title}</option>)}</select><button type="button" onClick={() => void refresh()}>更新</button></div></fieldset>
    <fieldset className="native-group"><legend>ウィンドウ位置・サイズ調整</legend><div className="inline-row wrapping"><button type="button" disabled={!selected} onClick={() => void maximize()}>最大化</button><button type="button" disabled={!selected} onClick={() => void syncCurrent()}>現在位置と同期</button><Toggle label="画面外を許可" checked={outside} onChange={setOutside} />{(["left", "top", "width", "height"] as (keyof WindowGeometry)[]).map((key) => <FieldRow key={key} label={{ left: "X", top: "Y", width: "幅", height: "高さ" }[key]}><input type="number" value={rect[key]} onChange={(event) => update(key, event.target.value)} /></FieldRow>)}<ToolButton tone="start" onClick={() => void apply()}>適用</ToolButton><button type="button" disabled={!canUndo} onClick={() => void undo()}>元に戻す</button></div></fieldset>
    <fieldset className="native-group window-preview-group"><legend>プレビュー</legend><RegionPreview region={applied} compact /><span className="rect-badge">X {applied.left}　Y {applied.top}　{applied.width} × {applied.height}</span><small>{message}</small></fieldset>
    <footer className="dialog-footer"><ToolButton tone="play" onClick={() => openMockWindow("recorder")}>録画ツールを開く</ToolButton><ToolButton onClick={closeCurrentWindow}>閉じる</ToolButton></footer>
  </main>;
}
