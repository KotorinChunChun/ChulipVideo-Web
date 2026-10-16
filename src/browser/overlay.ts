import type { InputRecord, OverlaySettings } from "../tauriApi";

const modifiers = new Set(["Ctrl", "Shift", "Alt", "Win"]);
const specialKeys = new Set([
  "Enter", "Space", "Esc", "BS", "Tab", "Del", "PageUp", "PageDown", "End", "Home",
  "Insert", "Left", "Up", "Right", "Down", "PrintScreen", "Pause", "CapsLock", "ScrollLock",
]);
const clickLabels: Record<string, string> = {
  "L-Click": "左クリック", "R-Click": "右クリック", "M-Click": "中央クリック",
  "X1-Click": "戻るクリック", "X2-Click": "進むクリック",
  "Wheel-Up": "ホイール上", "Wheel-Down": "ホイール下",
};

export type SubtitleInterval = { start: number; end: number; lines: string[] };

const tokens = (value: string) => value.split(",").map((part) => part.trim()).filter((part) => part && part !== "None");

/** 新旧の操作ログを読み込み、再生処理が要求する時刻順へ並べる。 */
export function parseInputTsv(text: string): InputRecord[] {
  const records: InputRecord[] = [];
  let firstRow = true;
  for (const [index, raw] of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).entries()) {
    if (!raw.trim()) continue;
    const columns = raw.split("\t");
    if (firstRow && columns[0].trim().toLowerCase() === "timestamp") {
      const header = columns.map((column) => column.trim().toLowerCase()).join("\t");
      if (header !== "timestamp\tframe\tx\ty\tclick\tkeys" && header !== "timestamp\tx\ty\tclick\tkeys") {
        throw new Error(`操作ログ ${index + 1} 行目: ヘッダーの列が不正です`);
      }
      firstRow = false;
      continue;
    }
    firstRow = false;
    try {
      if (columns.length !== 5 && columns.length !== 6) throw new Error("5 列または 6 列の TSV が必要です");
      const hasFrame = columns.length === 6;
      const coordinate = hasFrame ? 2 : 1;
      const record: InputRecord = {
        timestamp: parseNumber(columns[0], "時刻"),
        frame: hasFrame ? parseNumber(columns[1], "フレーム番号") : 0,
        x: parseNumber(columns[coordinate], "X 座標"),
        y: parseNumber(columns[coordinate + 1], "Y 座標"),
        click: columns[coordinate + 2].trim(),
        keys: columns[coordinate + 3].trim(),
      };
      validateRecord(record);
      records.push(record);
    } catch (error) {
      throw new Error(`操作ログ ${index + 1} 行目: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records.sort((left, right) => left.timestamp - right.timestamp);
}

function parseNumber(value: string, label: string): number {
  const number = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(number)) throw new Error(`${label}が数値ではありません`);
  const parsed = Number(number);
  if (!Number.isFinite(parsed)) throw new Error(`${label}は有限の数値で指定してください`);
  return parsed;
}

function validateRecord(record: InputRecord) {
  if (!Number.isFinite(record.timestamp) || record.timestamp < 0 || record.timestamp > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error("時刻は 0 以上の有限値で指定してください");
  }
  if (!Number.isSafeInteger(record.frame)) throw new Error("フレーム番号は安全に扱える整数で指定してください");
  for (const [label, value] of [["X", record.x], ["Y", record.y]] as const) {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error(`${label} 座標は 32 ビット整数で指定してください`);
  }
  if (typeof record.click !== "string" || typeof record.keys !== "string" || /[\u0000-\u001f\u007f]/.test(record.click + record.keys)) {
    throw new Error("クリック・キー情報に不正な文字が含まれています");
  }
}

function sortedRecords(records: InputRecord[]): InputRecord[] {
  records.forEach(validateRecord);
  return [...records].sort((left, right) => left.timestamp - right.timestamp);
}

/** 表示用の文字列。React のテキストなどとして描画し、HTML として挿入しない。 */
export function inputLabel(record: InputRecord | null): string {
  if (!record) return "";
  return [...tokens(record.keys), ...tokens(record.click).map((click) => Object.hasOwn(clickLabels, click) ? clickLabels[click] : click)].join(" + ");
}

function allowsDefaultSubtitle(record: InputRecord): boolean {
  const keys = tokens(record.keys);
  const clicks = tokens(record.click);
  const hasModifier = keys.some((key) => modifiers.has(key));
  const otherKeys = keys.filter((key) => !modifiers.has(key));
  if (!otherKeys.length && !clicks.length) return false;
  return clicks.every((click) => Object.hasOwn(clickLabels, click)) && otherKeys.every((key) => {
    if (/^[a-z0-9]$/i.test(key)) return hasModifier;
    return specialKeys.has(key) || /^F(?:[1-9]|1[0-2])$/.test(key);
  });
}

function normalizedSettings(settings: OverlaySettings): OverlaySettings {
  const bounded = (value: number, minimum: number, maximum: number, label: string) => {
    if (!Number.isFinite(value)) throw new Error(`${label}は有限の数値で指定してください`);
    return Math.min(maximum, Math.max(minimum, value));
  };
  const color = (value: string, label: string) => {
    if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) throw new Error(`${label}は #RRGGBB 形式で指定してください`);
    return value;
  };
  for (const key of ["showPointer", "showClickRipple", "showSubtitles"] as const) {
    if (typeof settings[key] !== "boolean") throw new Error("オーバーレイの表示設定が不正です");
  }
  return {
    ...settings,
    pointerSize: Math.round(bounded(settings.pointerSize, 8, 256, "ポインタサイズ")),
    rippleDuration: bounded(settings.rippleDuration, 0.05, 10, "波紋の表示時間"),
    subtitleFadeDuration: bounded(settings.subtitleFadeDuration, 0.05, 30, "字幕の表示時間"),
    subtitleMaxStack: Math.round(bounded(settings.subtitleMaxStack, 1, 20, "字幕の段数")),
    subtitleFontSize: Math.round(bounded(settings.subtitleFontSize, 8, 256, "字幕の文字サイズ")),
    pointerColor: color(settings.pointerColor, "ポインタ色"),
    pointerOutlineColor: color(settings.pointerOutlineColor, "ポインタの縁色"),
    subtitleForeground: color(settings.subtitleForeground, "字幕の文字色"),
    subtitleBackground: color(settings.subtitleBackground, "字幕の背景色"),
  };
}

/** 元動画時刻の字幕区間。各字幕の寿命と段数をプレビュー・出力で共有する。 */
export function buildSubtitleIntervals(records: InputRecord[], settings: OverlaySettings): SubtitleInterval[] {
  return subtitleIntervals(sortedRecords(records), normalizedSettings(settings));
}

function subtitleIntervals(records: InputRecord[], settings: OverlaySettings): SubtitleInterval[] {
  if (!settings.showSubtitles) return [];
  const events = records.filter(allowsDefaultSubtitle).map((record) => ({
    start: record.timestamp, end: record.timestamp + settings.subtitleFadeDuration, label: inputLabel(record),
  }));
  const boundaries = [...new Set(events.flatMap((event) => [event.start, event.end]))].sort((left, right) => left - right);
  const intervals: SubtitleInterval[] = [];
  let added = 0;
  let expired = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    while (added < events.length && events[added].start <= start) added++;
    while (expired < added && events[expired].end <= start) expired++;
    const lines = events.slice(Math.max(expired, added - settings.subtitleMaxStack), added).reverse().map((event) => event.label);
    if (lines.length) intervals.push({ start, end: boundaries[index + 1], lines });
  }
  return intervals;
}

/** buildSubtitleIntervals の結果を使い、時刻に対応する字幕を二分探索する。 */
export function getActiveSubtitleLines(intervals: SubtitleInterval[], timestamp: number): string[] {
  if (!Number.isFinite(timestamp)) return [];
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const interval = intervals[middle];
    if (timestamp < interval.start) high = middle - 1;
    else if (timestamp >= interval.end) low = middle + 1;
    else return [...interval.lines];
  }
  return [];
}

function assColor(value: string): string {
  return `&H00${value.slice(5, 7)}${value.slice(3, 5)}${value.slice(1, 3)}`.toUpperCase();
}

function assText(value: string): string {
  // ASS に任意の制御タグを持ち込まず、改行は生成側でのみ付与する。
  return value.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/[\r\n]/g, " ");
}

function assTime(centiseconds: number): string {
  const hours = Math.floor(centiseconds / 360000);
  const minutes = String(Math.floor(centiseconds / 6000) % 60).padStart(2, "0");
  const seconds = String(Math.floor(centiseconds / 100) % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}.${String(centiseconds % 100).padStart(2, "0")}`;
}

/** 元動画の解像度・座標で ASS を描画し、出力範囲の開始を時刻 0 にする。 */
export function buildAss(records: InputRecord[], settings: OverlaySettings, width: number, height: number, start: number, end: number): string {
  if (![width, height].every((size) => Number.isInteger(size) && size > 0 && size <= 65536)) throw new Error("動画の幅・高さが不正です");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > Number.MAX_SAFE_INTEGER / 100) throw new Error("出力する時刻の範囲が不正です");
  const sorted = sortedRecords(records);
  const options = normalizedSettings(settings);
  const output = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Input,Noto Sans JP,${options.subtitleFontSize},${assColor(options.subtitleForeground)},${assColor(options.subtitleForeground)},${assColor(options.subtitleBackground)},&H80000000,0,0,0,0,100,100,0,0,3,2,0,2,20,20,20,1`,
    `Style: Pointer,Noto Sans JP,20,${assColor(options.pointerColor)},${assColor(options.pointerColor)},${assColor(options.pointerOutlineColor)},&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const dialogue = (layer: number, from: number, until: number, style: string, content: string) => {
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end, until);
    if (clippedEnd <= clippedStart) return;
    const first = Math.round((clippedStart - start) * 100);
    const last = Math.round((clippedEnd - start) * 100);
    if (last <= first) return;
    output.push(`Dialogue: ${layer},${assTime(first)},${assTime(last)},${style},,0,0,0,,${content}`);
  };
  if (options.showPointer) {
    for (const [index, record] of sorted.entries()) {
      const { x, y } = record;
      if (x < -256 || y < -256 || x > width + 256 || y > height + 256) continue;
      const scale = Math.round(options.pointerSize / 36 * 100);
      dialogue(2, record.timestamp, sorted[index + 1]?.timestamp ?? record.timestamp + 1 / 30, "Pointer", `{\\an7\\pos(${x},${y})\\fscx${scale}\\fscy${scale}\\p1}m 0 0 l 0 28 l 7 21 l 13 34 l 18 31 l 12 18 l 23 18{\\p0}`);
      if (options.showClickRipple && tokens(record.click).length) {
        dialogue(1, record.timestamp, record.timestamp + options.rippleDuration, "Pointer", `{\\an5\\pos(${x},${y})\\1a&HFF&\\3a&H20&\\bord3\\p1}m 0 -20 b 11 -20 20 -11 20 0 b 20 11 11 20 0 20 b -11 20 -20 11 -20 0 b -20 -11 -11 -20 0 -20{\\p0}`);
      }
    }
  }
  for (const interval of subtitleIntervals(sorted, options)) {
    dialogue(1, interval.start, interval.end, "Input", interval.lines.map(assText).join("\\N"));
  }
  return `${output.join("\n")}\n`;
}
