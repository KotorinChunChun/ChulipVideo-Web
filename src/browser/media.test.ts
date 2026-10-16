import assert from "node:assert/strict";
import test from "node:test";
import { buildCropFilters, buildOverlayPasses, MEDIA_LIMITS, needsPlaybackProxy, parseProbeMetadata, validateExportRequest } from "./media";
import type { ExportRequest, OverlaySettings, VideoMetadata } from "../tauriApi";

const metadata: VideoMetadata = { path: "試験.mp4", width: 320, height: 180, fps: 30, duration: 10, frameCount: 300, codecName: "h264", formatName: "mp4" };
const request: ExportRequest = { input: "試験.mp4", output: "書出.mp4", format: "mp4", start: 1, end: 3, crop: null, fps: null, quality: 80, pngCompression: 3 };
const overlay: OverlaySettings = { showPointer: true, pointerSize: 36, pointerColor: "#ffffff", pointerOutlineColor: "#111111", showClickRipple: true, rippleDuration: 0.5, showSubtitles: true, subtitleFadeDuration: 1.2, subtitleMaxStack: 3, subtitleFontSize: 30, subtitleForeground: "#202020", subtitleBackground: "#ffffff" };

test("MOV・MKV・HEVC・ProResは再生用MP4を使い、通常のMP4は変換しない", () => {
  for (const [name, type, codec] of [["IMG_0001.MOV", "", "h264"], ["video", "video/quicktime", "h264"], ["video.mp4", "video/mp4", "hevc"], ["video.mov", "", "prores"], ["録画.MKV", "", "h264"], ["動画", "video/x-matroska", "h264"], ["動画", "application/x-matroska", "h264"]]) {
    assert.equal(needsPlaybackProxy({ name, type }, { ...metadata, codecName: codec }), true);
  }
  assert.equal(needsPlaybackProxy({ name: "video.mp4", type: "video/mp4" }, metadata), false);
});

test("ffprobe の分数 FPS・音声併存・動画の時間を読み取る", () => {
  const result = parseProbeMetadata(JSON.stringify({ streams: [{ codec_type: "audio" }, { codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001", r_frame_rate: "30/1", duration: "2.002", nb_frames: "60", codec_name: "h264" }], format: { duration: "2.1", format_name: "mov,mp4" } }), "日本語.mp4");
  assert.equal(result.path, "日本語.mp4");
  assert.equal(result.fps, 30000 / 1001);
  assert.equal(result.duration, 2.002);
  assert.equal(result.frameCount, 60);
});

test("WebM の format duration と r_frame_rate をフォールバックに使う", () => {
  const result = parseProbeMetadata(JSON.stringify({ streams: [{ codec_type: "video", width: 320, height: 180, avg_frame_rate: "0/0", r_frame_rate: "24/1" }], format: { duration: "4.25", format_name: "matroska,webm" } }), "silent.webm");
  assert.equal(result.fps, 24);
  assert.equal(result.duration, 4.25);
  assert.equal(result.frameCount, null);
});

test("回転動画の表示寸法を補正し、添付画像を映像と誤認しない", () => {
  const result = parseProbeMetadata(JSON.stringify({ streams: [{ codec_type: "video", disposition: { attached_pic: 1 } }, { codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1", side_data_list: [{ rotation: -90 }] }], format: { duration: "2" } }), "縦.mp4");
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
});

test("壊れた JSON、映像なし、不正 FPS、不正寸法を拒否する", () => {
  assert.throws(() => parseProbeMetadata("", "bad.mp4"), /JSON/);
  assert.throws(() => parseProbeMetadata('{"streams":[{"codec_type":"audio"}]}', "audio.mp3"), /映像ストリーム/);
  assert.throws(() => parseProbeMetadata(JSON.stringify({ streams: [{ codec_type: "video", width: 320, height: 180, avg_frame_rate: "0/0" }], format: { duration: "2" } }), "bad.mp4"), /FPS/);
  assert.throws(() => parseProbeMetadata(JSON.stringify({ streams: [{ codec_type: "video", width: 9000, height: 180, avg_frame_rate: "30/1" }], format: { duration: "2" } }), "big.mp4"), /8192/);
});

test("枠外クロップは左上を黒で埋め、奇数の座標と寸法を保持する", () => {
  assert.deepEqual(buildCropFilters(320, 180, { x: -11, y: -3, width: 301, height: 179 }, false), ["format=rgba", "pad=331:183:11:3:color=black", "crop=301:179:0:0:exact=1"]);
  assert.deepEqual(buildCropFilters(320, 180, { x: 11, y: 3, width: 321, height: 181 }, true), ["format=rgba", "pad=332:184:0:0:color=black", "crop=321:181:11:3:exact=1", "pad=322:182:0:0:color=black"]);
});

test("MP4 は未クロップでも奇数寸法を偶数へ拡張する", () => {
  assert.deepEqual(buildCropFilters(321, 181, null, true), ["pad=322:182:0:0:color=black"]);
  assert.deepEqual(buildCropFilters(321, 181, null, false), []);
});

test("クロップしても字幕が消えないように座標系と ASS ファイルを分離する", () => {
  const passes = buildOverlayPasses(320, 180, { x: 16, y: 8, width: 160, height: 90 }, false, overlay);
  assert.equal(passes.length, 2);
  assert.deepEqual(passes.map(pass => [pass.phase, pass.width, pass.height]), [["pointer", 320, 180], ["subtitle", 160, 90]]);
  assert.equal(passes[0].settings.showPointer, true);
  assert.equal(passes[0].settings.showSubtitles, false);
  assert.equal(passes[1].settings.showPointer, false);
  assert.equal(passes[1].settings.showClickRipple, false);
  assert.equal(passes[1].settings.showSubtitles, true);
  assert.equal(overlay.showSubtitles, true);
});

test("字幕だけの表示と MP4 偶数拡張後の字幕領域に対応する", () => {
  const passes = buildOverlayPasses(320, 180, { x: 16, y: 8, width: 161, height: 91 }, true, { ...overlay, showPointer: false });
  assert.deepEqual(passes.map(pass => [pass.phase, pass.width, pass.height]), [["subtitle", 162, 92]]);
  assert.deepEqual(buildOverlayPasses(320, 180, null, false, null), []);
});

test("極端な枠外座標、非整数、負数の寸法をメモリ確保前に拒否する", () => {
  assert.throws(() => buildCropFilters(320, 180, { x: -1000000, y: 0, width: 100, height: 100 }, false), /8192/);
  assert.throws(() => buildCropFilters(320, 180, { x: 0.5, y: 0, width: 100, height: 100 }, false), /整数/);
  assert.throws(() => buildCropFilters(320, 180, { x: 0, y: 0, width: -1, height: 100 }, false), /8192/);
});

test("範囲終了は排他的で PNG 連番は元 FPS の枚数となる", () => {
  assert.deepEqual(validateExportRequest(metadata, { ...request, format: "png-sequence", start: 1, end: 2 }), { duration: 1, fps: 30, frames: 30 });
  assert.equal(validateExportRequest(metadata, { ...request, format: "png-sequence", start: 0, end: 0.1 }).frames, 3);
  assert.equal(validateExportRequest(metadata, { ...request, format: "gif", fps: 60 }).fps, 15);
});

test("不正範囲・動画外終了・不正 FPS を拒否する", () => {
  for (const patch of [{ start: -1 }, { start: 3, end: 3 }, { end: 10.1 }, { start: NaN }, { fps: 0 }, { fps: 241 }]) {
    assert.throws(() => validateExportRequest(metadata, { ...request, ...patch }));
  }
});

test("PNG の枚数と展開画素合計の両方に上限を適用する", () => {
  assert.throws(() => validateExportRequest({ ...metadata, duration: 100 }, { ...request, format: "png-sequence", start: 0, end: 40 }), /1000/);
  assert.throws(() => validateExportRequest({ ...metadata, width: 3840, height: 2160 }, { ...request, format: "png-sequence", start: 0, end: 1 }), /512 MiB/);
});
