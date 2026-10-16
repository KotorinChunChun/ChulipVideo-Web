import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { GlobalConfig } from "../tauriApi";
import "./settings.css";

type DialogKind = "app" | "overlay" | "help";
type SettingsValues = Record<string, unknown>;
type NumberRule = { min: number; max: number; step: number; fallback: number };

const numberRules: Record<string, NumberRule> = {
  play_speed: { min: 0.1, max: 4, step: 0.1, fallback: 1 },
  png_compression: { min: 0, max: 9, step: 1, fallback: 3 },
  overlay_pointer_size: { min: 16, max: 72, step: 1, fallback: 36 },
  overlay_ripple_duration: { min: 0.1, max: 3, step: 0.1, fallback: 0.5 },
  overlay_subtitle_duration: { min: 0.1, max: 10, step: 0.1, fallback: 1.2 },
  overlay_subtitle_stack: { min: 1, max: 6, step: 1, fallback: 3 },
  overlay_subtitle_font_size: { min: 12, max: 96, step: 1, fallback: 30 },
};

const appDefaults = {
  play_speed: 1,
  play_range: false,
  play_loop: false,
  seek_step: "1秒",
  png_compression: 3,
};

const overlayDefaults = {
  show_trajectory: true,
  show_subtitle: true,
  overlay_pointer_size: 36,
  overlay_pointer_color: "#ffffff",
  overlay_pointer_outline: "#111111",
  overlay_ripple: true,
  overlay_ripple_duration: 0.5,
  overlay_subtitle_duration: 1.2,
  overlay_subtitle_stack: 3,
  overlay_subtitle_font_size: 30,
  overlay_subtitle_color: "#202020",
  overlay_subtitle_background: "#ffffff",
};

function normalizedNumber(value: unknown, rule: NumberRule) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  const finite = Number.isFinite(parsed) ? parsed : rule.fallback;
  const bounded = Math.min(rule.max, Math.max(rule.min, finite));
  return rule.step === 1 ? Math.round(bounded) : Math.round(bounded * 100) / 100;
}

function normalizedValues(kind: DialogKind, source: SettingsValues): SettingsValues {
  const defaults = kind === "overlay" ? overlayDefaults : appDefaults;
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = source[key];
    if (typeof fallback === "number") return [key, normalizedNumber(value, numberRules[key])];
    if (typeof fallback === "boolean") return [key, typeof value === "boolean" ? value : fallback];
    if (key === "seek_step") return [key, ["1秒", "5秒", "1フレーム"].includes(String(value)) ? value : fallback];
    return [key, typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback];
  }));
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="browser-settings-field"><span>{label}</span><span className="browser-settings-value">{children}</span></label>;
}

export function BrowserSettingsDialog({ kind, config, onSave, onClose }: {
  kind: DialogKind;
  config: GlobalConfig;
  onSave: (value: GlobalConfig) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SettingsValues>(() => normalizedValues(kind, config));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const configRef = useRef(config);
  const savingRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  closeRef.current = onClose;
  configRef.current = config;
  savingRef.current = saving;

  useEffect(() => {
    setDraft(normalizedValues(kind, configRef.current));
    setMessage("");
    setError("");
  }, [kind]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.matches(":disabled") && element.getClientRects().length > 0);
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!savingRef.current) closeRef.current();
      } else if (event.key === "Tab") {
        const targets = focusable();
        const first = targets[0];
        const last = targets[targets.length - 1];
        if (!first) {
          event.preventDefault();
          dialog.focus();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    focusFirst();
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const update = (key: string, value: unknown) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage("");
    setError("");
  };
  const numberField = (key: string, label: string, unit: string) => {
    const rule = numberRules[key];
    return <Field label={label}><input type="number" min={rule.min} max={rule.max} step={rule.step} value={String(draft[key] ?? rule.fallback)}
      onChange={(event) => update(key, event.currentTarget.value)}
      onBlur={() => setDraft((current) => ({ ...current, [key]: normalizedNumber(current[key], rule) }))} /><span>{unit}</span></Field>;
  };
  const checkbox = (key: string, label: string) => <label className="browser-settings-check"><input type="checkbox" checked={draft[key] === true} onChange={(event) => update(key, event.currentTarget.checked)} /><span>{label}</span></label>;
  const colorField = (key: string, label: string) => <Field label={label}><input type="color" value={String(draft[key])} onChange={(event) => update(key, event.currentTarget.value)} /><span className="browser-settings-color-code">{String(draft[key])}</span></Field>;
  const reset = () => {
    setDraft({ ...(kind === "overlay" ? overlayDefaults : appDefaults) });
    setError("");
    setMessage("この画面の項目を既定値に戻しました。保存すると適用されます。");
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || kind === "help") return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    const normalized = normalizedValues(kind, draft);
    setDraft(normalized);
    try {
      await onSave({ ...configRef.current, ...normalized });
      setMessage("設定を保存しました。");
    } catch (reason) {
      setError(`設定を保存できませんでした。${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const title = kind === "app" ? "ブラウザ版の設定" : kind === "overlay" ? "操作情報の表示設定" : "ブラウザ版の使い方";
  const description = kind === "app" ? "再生とPNG出力の動作を設定します。" : kind === "overlay" ? "読み込んだ操作履歴のポインターと字幕を設定します。" : "動画を開き、範囲を選んで書き出せます。";

  return <div className="browser-settings-backdrop" onClick={(event) => {
    if (event.target === event.currentTarget && !savingRef.current) onClose();
  }}>
    <section ref={dialogRef} className="browser-settings-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={saving} tabIndex={-1} onKeyDown={(event) => event.stopPropagation()}>
      <header className="browser-settings-header"><div><h1 id={titleId}>{title}</h1><p id={descriptionId}>{description}</p></div><button type="button" className="browser-settings-dismiss" aria-label="設定画面を閉じる" onClick={onClose} disabled={saving}>×</button></header>
      <form className="browser-settings-form" onSubmit={(event) => void save(event)} noValidate>
        <div className="browser-settings-body">
          {kind === "app" && <>
            <fieldset disabled={saving}><legend>再生</legend>
              {numberField("play_speed", "再生速度", "倍（0.1〜4）")}
              {checkbox("play_range", "指定した区間を再生する")}
              {checkbox("play_loop", "繰り返し再生する")}
              <Field label="← → キーの移動量"><select value={String(draft.seek_step)} onChange={(event) => update("seek_step", event.currentTarget.value)}><option>1秒</option><option>5秒</option><option>1フレーム</option></select></Field>
            </fieldset>
            <fieldset disabled={saving}><legend>PNG出力</legend>{numberField("png_compression", "PNG圧縮レベル", "（0〜9）")}<p className="browser-settings-note">値を大きくすると圧縮に時間がかかります。画質は変わりません。</p></fieldset>
          </>}
          {kind === "overlay" && <>
            <p className="browser-settings-note">操作履歴TSVを読み込むと利用できます。保存した設定はプレビューと出力に反映されます。</p>
            <fieldset disabled={saving}><legend>マウスポインター</legend>
              {checkbox("show_trajectory", "ポインターを表示する")}
              {numberField("overlay_pointer_size", "ポインターの大きさ", "px（16〜72）")}
              {colorField("overlay_pointer_color", "ポインターの色")}
              {colorField("overlay_pointer_outline", "輪郭の色")}
              {checkbox("overlay_ripple", "クリック時の波紋を表示する")}
              {numberField("overlay_ripple_duration", "波紋の表示時間", "秒（0.1〜3）")}
            </fieldset>
            <fieldset disabled={saving}><legend>入力字幕</legend>
              {checkbox("show_subtitle", "入力字幕を表示する")}
              {numberField("overlay_subtitle_duration", "字幕の表示時間", "秒（0.1〜10）")}
              {numberField("overlay_subtitle_stack", "字幕の最大表示数", "段（1〜6）")}
              {numberField("overlay_subtitle_font_size", "文字の大きさ", "px（12〜96）")}
              {colorField("overlay_subtitle_color", "文字の色")}
              {colorField("overlay_subtitle_background", "背景の色")}
            </fieldset>
          </>}
          {kind === "help" && <>
            <section className="browser-settings-help-section"><h2>動画の編集</h2><ol><li>動画ファイルを選択して開きます。</li><li>開始・終了位置と切り抜き範囲を調整します。</li><li>MP4・GIF・PNG連番を選んで出力します。PNG連番はZIPファイルで保存します。</li></ol><p>動画は端末内のブラウザで処理します。操作情報を重ねる場合は、TSVファイルを別途選択してください。</p><p>設定を保存しておくと、同じ動画を再選択したときに編集状態を復元できます。設定は現在のブラウザに保存されます。</p></section>
            <section className="browser-settings-help-section"><h2>キーボード操作</h2><table><tbody>
              <tr><th scope="row"><kbd>Space</kbd></th><td>再生 / 一時停止</td></tr>
              <tr><th scope="row"><kbd>←</kbd> <kbd>→</kbd></th><td>設定した移動量で前後に移動</td></tr>
              <tr><th scope="row"><kbd>Home</kbd> / <kbd>End</kbd></th><td>動画の先頭 / 末尾へ移動。区間再生中は区間の開始 / 終了へ移動</td></tr>
              <tr><th scope="row"><kbd>I</kbd> / <kbd>O</kbd></th><td>現在位置を区間の開始 / 終了に設定</td></tr>
              <tr><th scope="row"><kbd>L</kbd></th><td>繰り返し再生の切り替え</td></tr>
            </tbody></table><p className="browser-settings-note">文字入力中や設定画面を開いている間は、動画操作のショートカットは働きません。</p></section>
            <section className="browser-settings-help-section"><h2>試作版の範囲</h2><p>映像キャプチャ・録画画面は対象外です。MOV・MKV・HEVC動画は端末内で再生用MP4を準備します（初回読み込みに時間がかかります）。書き出しには元動画を使います。HDR・Dolby Visionの色やメタデータの維持は保証していません。入力動画に固定の容量制限はありません。PNG連番は1回の出力につき1,000枚までです。長い動画や高解像度の出力は、端末の空きメモリーによって処理できない場合があります。</p></section>
          </>}
        </div>
        <div className="browser-settings-feedback" aria-live="polite">{error ? <p className="browser-settings-error" role="alert">{error}</p> : message ? <p>{message}</p> : null}</div>
        <footer className="browser-settings-footer">
          {kind !== "help" && <><button type="button" onClick={reset} disabled={saving}>既定値に戻す</button><button type="submit" className="browser-settings-save" disabled={saving}>{saving ? "保存しています…" : "適用して保存"}</button></>}
          <button type="button" onClick={onClose} disabled={saving}>閉じる</button>
        </footer>
      </form>
    </section>
  </div>;
}
