import assert from "node:assert/strict";
import test from "node:test";
import type { InputRecord, OverlaySettings } from "../tauriApi";
import { buildAss, buildSubtitleIntervals, getActiveSubtitleLines, inputLabel, parseInputTsv } from "./overlay";

const settings: OverlaySettings = {
  showPointer: true, pointerSize: 36, pointerColor: "#ffffff", pointerOutlineColor: "#111111",
  showClickRipple: true, rippleDuration: 0.5, showSubtitles: true, subtitleFadeDuration: 1,
  subtitleMaxStack: 3, subtitleFontSize: 30, subtitleForeground: "#202020", subtitleBackground: "#ffffff",
};
const record = (timestamp: number, keys = "None", click = "None", x = 110, y = 220): InputRecord => ({
  timestamp, frame: Math.round(timestamp * 30), x, y, click, keys,
});

test("BOM・CRLF・ヘッダー付き 6 列と旧 5 列を読み込み、同時刻の順序を維持する", () => {
  const value = "\uFEFFtimestamp\tframe\tx\ty\tclick\tkeys\r\n1.5\t45\t10\t20\tNone\tCtrl,C\r\n0.5\t15\t-10\t-20\tL-Click\tNone\r\n1.5\t46\t11\t21\tR-Click\tNone\r\n";
  const parsed = parseInputTsv(value);
  assert.deepEqual(parsed.map((item) => item.frame), [15, 45, 46]);
  assert.equal(parsed[0].x, -10);
  assert.deepEqual(parseInputTsv("timestamp\tx\ty\tclick\tkeys\n0\t1\t2\tL-Click\tCtrl"), [record(0, "Ctrl", "L-Click", 1, 2)]);
  assert.deepEqual(parseInputTsv("\n\n"), []);
});

test("不正行は黙って欠落させず、日本語の行番号付きエラーにする", () => {
  for (const line of [
    "NaN\t0\t1\t2\tNone\tNone", "Infinity\t0\t1\t2\tNone\tNone",
    "-1\t0\t1\t2\tNone\tNone", "\t0\t1\t2\tNone\tNone",
    "0\t0\t1.5\t2\tNone\tNone", "0\t0\t2147483648\t2\tNone\tNone",
    "0\t9007199254740992\t1\t2\tNone\tNone", "0\t0\t1\t2",
    "0\t0\t1\t2\tNone\tA\u0000", "0x10\t0\t1\t2\tNone\tNone",
  ]) assert.throws(() => parseInputTsv(`timestamp\tframe\tx\ty\tclick\tkeys\n${line}`), /操作ログ 2 行目:/);
  assert.throws(() => parseInputTsv("timestamp\tframe\ty\tx\tclick\tkeys"), /ヘッダー/);
});

test("クリック名を日本語に変換し、None と空要素を表示しない", () => {
  assert.equal(inputLabel(record(0, "Ctrl, Shift, None", "X1-Click,Wheel-Down")), "Ctrl + Shift + 戻るクリック + ホイール下");
  assert.equal(inputLabel(record(0)), "");
  assert.equal(inputLabel(null), "");
  assert.equal(inputLabel(record(0, "None", "constructor")), "constructor");
});

test("字幕は単独英数字・修飾キー・未知キーを除外し、既定のショートカットを残す", () => {
  const intervals = buildSubtitleIntervals([
    record(0, "a"), record(1, "7"), record(2, "Ctrl"), record(3, "Unknown"),
    record(4, "Ctrl,c"), record(5, "F12"), record(6, "None", "L-Click"),
    record(7, "Ctrl,A,Unknown"), record(8, "Shift", "R-Click"),
  ], settings);
  assert.deepEqual(intervals.map((interval) => interval.lines), [["Ctrl + c"], ["F12"], ["左クリック"], ["Shift + 右クリック"]]);
});

test("字幕の段数は新しい順に制限し、入力がなくても各字幕の寿命で消す", () => {
  const intervals = buildSubtitleIntervals([
    record(0, "Enter"), record(0.25, "Tab"), record(0.5, "Esc"),
  ], { ...settings, subtitleMaxStack: 2 });
  assert.deepEqual(getActiveSubtitleLines(intervals, 0.75), ["Esc", "Tab"]);
  assert.deepEqual(getActiveSubtitleLines(intervals, 1.25), ["Esc"]);
  assert.deepEqual(getActiveSubtitleLines(intervals, 1.5), []);
  assert.deepEqual(getActiveSubtitleLines(intervals, -1), []);
  assert.deepEqual(getActiveSubtitleLines(intervals, Number.NaN), []);
  const selected = getActiveSubtitleLines(intervals, 0.75);
  selected.pop();
  assert.deepEqual(getActiveSubtitleLines(intervals, 0.75), ["Esc", "Tab"]);
});

test("同時刻のイベントを一つの字幕区間にまとめる", () => {
  const intervals = buildSubtitleIntervals([record(1, "Enter"), record(1, "Tab")], settings);
  assert.deepEqual(intervals, [{ start: 1, end: 2, lines: ["Tab", "Enter"] }]);
});

test("ASS は元解像度・元座標を使い、字幕とポインタの時刻を開始 0 へ移す", () => {
  const ass = buildAss([record(5, "Ctrl", "L-Click"), record(5.5)], settings, 800, 600, 5.25, 5.75);
  assert.match(ass, /PlayResX: 800\nPlayResY: 600/);
  assert.match(ass, /Style: Input,Noto Sans JP,30/);
  assert.match(ass, /Dialogue: 2,0:00:00\.00,0:00:00\.25,Pointer.*\\pos\(110,220\)/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:00\.50,Input.*Ctrl \+ 左クリック/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:00\.25,Pointer.*\\bord3/);
  assert.doesNotMatch(ass, /0:00:05/);
});

test("クリック直後のフレーム境界を過ぎていても波紋の寿命を維持する", () => {
  const ass = buildAss([record(0, "None", "L-Click"), record(0.03)], settings, 800, 600, 0.25, 0.75);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:00\.25,Pointer.*\\bord3/);
});

test("ASS 字幕はスタック改行を使い、出力範囲外を含めない", () => {
  const ass = buildAss([record(0, "Enter"), record(0.25, "Tab"), record(5, "Esc")], settings, 800, 600, 0.5, 1.5);
  assert.match(ass, /Tab\\NEnter/);
  assert.doesNotMatch(ass, /Esc/);
  assert.match(ass, /Dialogue: 1,0:00:00\.50,0:00:00\.75,Input.*Tab$/m);
});

test("表示無効時には ASS の Dialogue を生成しない", () => {
  assert.doesNotMatch(buildAss([record(0, "Enter", "L-Click")], { ...settings, showPointer: false, showSubtitles: false }, 800, 600, 0, 1), /Dialogue:/);
  assert.deepEqual(buildSubtitleIntervals([record(0, "Enter")], { ...settings, showSubtitles: false }), []);
});

test("不正値や ASS タグの注入を拒否し、NaN を出力しない", () => {
  assert.throws(() => buildAss([], settings, 0, 600, 0, 1), /幅・高さ/);
  assert.throws(() => buildAss([], settings, 800, 600, 1, 1), /時刻の範囲/);
  assert.throws(() => buildAss([], settings, 800, 600, 0, Infinity), /時刻の範囲/);
  assert.throws(() => buildAss([], { ...settings, pointerSize: NaN }, 800, 600, 0, 1), /ポインタサイズ/);
  assert.throws(() => buildAss([], { ...settings, pointerColor: "#ffffff\n[Events]" }, 800, 600, 0, 1), /ポインタ色/);
  assert.throws(() => buildAss([{ ...record(0), x: NaN }], settings, 800, 600, 0, 1), /X 座標/);
  const malicious = buildAss([record(0, "{\\pos(999,999)}", "L-Click")], settings, 800, 600, 0, 1);
  assert.doesNotMatch(malicious, /999|NaN|Infinity/);
  assert.doesNotMatch(malicious, /,Input,/);
});

test("ASS の色は BGR に変換し、短すぎるゼロ長区間を生成しない", () => {
  const ass = buildAss([record(0, "Enter"), record(0.001)], { ...settings, subtitleForeground: "#123456" }, 800, 600, 0, 1);
  assert.match(ass, /&H00563412/);
  assert.doesNotMatch(ass, /Dialogue: 2,0:00:00\.00,0:00:00\.00/);
});
