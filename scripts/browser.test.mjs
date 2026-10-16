import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
import { unzipSync } from "fflate";
import { createFixtures, evidenceDirectory as evidenceRoot, ffmpegPath, runFfmpeg } from "./create-web-fixtures.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const targetUrl = process.env.CHULIP_WEB_URL ?? "http://127.0.0.1:1421";
const expectedOrigin = new URL(targetUrl).origin;
const evidenceDirectory = path.join(evidenceRoot, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const results = { startedAt: new Date().toISOString(), url: targetUrl, ffmpeg: ffmpegPath, evidenceDirectory, steps: [], requests: [], consoleErrors: [], pageErrors: [], downloads: [], viewports: [], status: "running" };
const downloadDirectory = path.join(evidenceDirectory, "downloads");
let browser, context, page;

async function saveResults() {
  await writeFile(path.join(evidenceDirectory, "browser-results.json"), JSON.stringify(results, null, 2), "utf8");
}
async function step(name, operation) {
  const record = { name, startedAt: new Date().toISOString(), status: "running" };
  results.steps.push(record);
  console.log(`確認中: ${name}`);
  try { record.details = await operation(); record.status = "passed"; }
  catch (error) { record.status = "failed"; record.error = error instanceof Error ? error.stack : String(error); throw error; }
  finally { record.finishedAt = new Date().toISOString(); await saveResults(); }
}
async function screenshot(name) {
  const filename = path.join(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path: filename, fullPage: true });
  return filename;
}
async function openVideo(filename) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /動画を開く/ }).click();
  await (await chooser).setFiles(filename);
  await page.getByText("動画を読み込みました", { exact: true }).waitFor({ timeout: 120000 });
  await page.locator("video").waitFor({ state: "attached" });
}
async function setRange(start, end) {
  await page.getByRole("tab", { name: "時間", exact: true }).click();
  // 先に終了を設定し、入力中に現在の開始と逆転することを避ける。
  await page.getByLabel("終了秒", { exact: true }).fill(String(end));
  await page.getByLabel("開始秒", { exact: true }).fill(String(start));
}
async function setCrop(x, y, width, height) {
  await page.getByRole("tab", { name: "切り抜き", exact: true }).click();
  // 位置を先に動かし、旧座標に対するクランプで希望サイズが縮まないようにする。
  for (const [label, value] of [["クロップX", x], ["クロップY", y], ["クロップ幅", width], ["クロップ高さ", height]]) {
    await page.getByLabel(label, { exact: true }).fill(String(value));
  }
}
async function seek(timestamp) {
  await page.getByLabel("シーク", { exact: true }).fill(String(timestamp));
  await page.waitForFunction(value => {
    const video = document.querySelector("video");
    return video && Math.abs(video.currentTime - value) < 0.05 && !video.seeking && video.readyState >= 2;
  }, timestamp);
}
async function overlayEnabled(enabled) {
  await page.getByRole("tab", { name: "字幕", exact: true }).click();
  await page.getByRole("checkbox", { name: "マウスポインタを表示", exact: true }).setChecked(enabled);
  await page.getByRole("checkbox", { name: "マウス・キー入力字幕を表示", exact: true }).setChecked(enabled);
}
async function saveDownload(download, filename) {
  const output = path.join(downloadDirectory, filename);
  await download.saveAs(output);
  const failure = await download.failure();
  assert.equal(failure, null, `ダウンロード失敗: ${filename}`);
  const bytes = await readFile(output);
  assert.ok(bytes.length > 0, `空の出力: ${filename}`);
  const item = { filename: output, suggestedFilename: download.suggestedFilename(), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  results.downloads.push(item);
  return output;
}
async function exportJob(buttonName, filename) {
  await page.getByRole("tab", { name: /PNG/.test(String(buttonName)) ? "画像保存" : "動画保存", exact: true }).click();
  const previous = await page.locator(".export-job").count() ? await page.locator(".export-job").first().getAttribute("data-job-id") : null;
  await page.getByRole("button", { name: buttonName }).click();
  await page.waitForFunction(id => {
    const first = document.querySelector(".export-job");
    return first?.getAttribute("data-job-id") && first.getAttribute("data-job-id") !== id;
  }, previous);
  const job = page.locator(".export-job").first();
  await page.waitForFunction(() => {
    const job = document.querySelector(".export-job");
    return job && ["state-completed", "state-failed", "state-cancelled"].some(state => job.classList.contains(state));
  }, undefined, { timeout: 180000 });
  const state = await job.getAttribute("class");
  assert.ok(state?.includes("state-completed"), `出力失敗: ${await job.innerText()}`);
  const downloading = page.waitForEvent("download");
  await job.getByRole("link", { name: "ダウンロード", exact: true }).click();
  return saveDownload(await downloading, filename);
}
async function currentPng(filename) {
  await page.getByRole("tab", { name: "画像保存", exact: true }).click();
  const downloading = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: /現在PNG保存/ }).click();
  return saveDownload(await downloading, filename);
}
async function mediaInfo(filename) {
  const result = runFfmpeg(["-hide_banner", "-i", filename, "-map", "0:v:0", "-progress", "pipe:1", "-f", "null", "-"]);
  await writeFile(`${filename}.decode.log`, `${result.stdout}\n${result.stderr}`, "utf8");
  assert.doesNotMatch(result.stderr, /Error while decoding|Invalid data found|corrupt decoded frame/i);
  const stream = result.stderr.split(/\r?\n/).find(line => /Stream #0.*Video:/.test(line));
  assert.ok(stream, "映像ストリームがありません");
  const dimensions = stream.match(/(?:,|\s)(\d{2,5})x(\d{2,5})(?:[\s,\[])/);
  assert.ok(dimensions, `映像寸法が不明です: ${stream}`);
  const duration = result.stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null;
  const frames = [...result.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1];
  return { width: Number(dimensions[1]), height: Number(dimensions[2]), duration: seconds, frames: frames ? Number(frames) : null, audio: /Stream #0.*Audio:/.test(result.stderr), stream };
}
async function pngInfo(filename) {
  const data = await readFile(filename);
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG シグネチャが不正です");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), bytes: data.length };
}
async function decodedPixels(filename) {
  return runFfmpeg(["-v", "error", "-i", filename, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: null }).stdout;
}
function changedPixelCount(before, after, firstPixel = 0) {
  assert.equal(before.length, after.length, "比較画像の画素数が一致しません");
  let changed = 0;
  for (let index = firstPixel * 3; index < before.length; index += 3) {
    if (Math.abs(before[index] - after[index]) + Math.abs(before[index + 1] - after[index + 1]) + Math.abs(before[index + 2] - after[index + 2]) > 96) changed++;
  }
  return changed;
}
async function samplePlayback(count, intervalMilliseconds = 250) {
  const samples = [];
  for (let index = 0; index <= count; index++) {
    if (index) await new Promise(resolve => setTimeout(resolve, intervalMilliseconds));
    samples.push(await page.locator("video").evaluate(video => ({ wallTime: Date.now(), currentTime: video.currentTime, paused: video.paused, ended: video.ended, playbackRate: video.playbackRate, readyState: video.readyState })));
  }
  return samples;
}
async function geometry(width, height) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await page.evaluate(() => {
    const visible = [...document.querySelectorAll("button")].filter(button => button.getClientRects().length && getComputedStyle(button).visibility !== "hidden");
    const buttons = visible.map(button => {
      const rect = button.getBoundingClientRect();
      return { label: button.getAttribute("aria-label") || button.title || button.innerText, x: rect.x, y: rect.y, width: rect.width, height: rect.height, disabled: button.disabled, outside: rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1, horizontalOverflow: rect.left < -1 || rect.right > innerWidth + 1 };
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, buttons, outside: buttons.filter(button => button.outside) };
  });
  results.viewports.push(result);
  await screenshot(`viewport-${width}x${height}`);
  assert.deepEqual(result.buttons.filter(button => button.horizontalOverflow), [], `${width}x${height} で横にはみ出すボタンがあります`);
  assert.ok(result.scrollWidth <= width + 1, `${width}x${height} で横スクロールが発生しました`);
  const buttons = page.locator("button");
  let reachable = 0;
  for (let index = 0; index < await buttons.count(); index++) {
    const button = buttons.nth(index);
    if (!await button.isVisible()) continue;
    await button.scrollIntoViewIfNeeded();
    const rect = await button.boundingBox();
    assert.ok(rect && rect.y >= -1 && rect.y + rect.height <= height + 1, `縦スクロールしても操作できないボタン: ${await button.innerText()}`);
    if (await button.isEnabled()) await button.click({ trial: true, timeout: 3000 });
    reachable++;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  result.reachableButtons = reachable;
  result.acceptance = "横はみ出しがなく、縦スクロールで全ボタンへ到達できること";
  return result;
}

try {
  await mkdir(downloadDirectory, { recursive: true });
  console.log(`証跡保存先: ${evidenceDirectory}`);
  const fixtures = await createFixtures();
  const launchOptions = { headless: process.env.CHULIP_TEST_HEADED !== "1" };
  if (process.env.CHULIP_TEST_BROWSER) launchOptions.channel = process.env.CHULIP_TEST_BROWSER;
  try { browser = await chromium.launch(launchOptions); }
  catch (error) {
    if (launchOptions.channel) throw error;
    browser = await chromium.launch({ ...launchOptions, channel: "chrome" });
  }
  context = await browser.newContext({ viewport: { width: 1365, height: 900 }, acceptDownloads: true, locale: "ja-JP", ...(process.env.CHULIP_RECORD_VIDEO === "1" ? { recordVideo: { dir: path.join(evidenceDirectory, "recordings"), size: { width: 1365, height: 900 } } } : {}) });
  // Worker の公開 message イベントだけを記録し、WASM 内の失敗も証跡へ残す。
  await context.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.__chulipTestWorkerLogs = [];
    window.__chulipTestAssFiles = {};
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", event => {
          if (event.data?.type === "LOG") {
            window.__chulipTestWorkerLogs.push(event.data.data);
            if (window.__chulipTestWorkerLogs.length > 1000) window.__chulipTestWorkerLogs.shift();
          }
        });
      }
      postMessage(message, ...rest) {
        if (message?.type === "WRITE_FILE" && message.data.path.endsWith(".ass")) {
          window.__chulipTestAssFiles[message.data.path] = message.data.data;
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
  context.on("request", request => {
    if (/^https?:/i.test(request.url())) results.requests.push({ url: request.url(), method: request.method(), resourceType: request.resourceType() });
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("console", message => { if (message.type() === "error") results.consoleErrors.push(message.text()); });
  page.on("pageerror", error => results.pageErrors.push(error.stack ?? error.message));
  page.on("dialog", dialog => dialog.accept());
  await step("メイン画面を開き、音声付き動画をブラウザから選択", async () => {
    await page.goto(targetUrl, { waitUntil: "networkidle" });
    await openVideo(fixtures.audio);
    await overlayEnabled(false);
    await setRange(1, 3);
    await setCrop(16, 8, 160, 90);
    await screenshot("loaded-cropped");
    return { fixture: fixtures.audio, range: [1, 3], crop: [16, 8, 160, 90] };
  });
  await step("MP4 の区間・クロップ・音声保持と全フレーム decode", async () => {
    const file = await exportJob(/MP4 動画保存/, "cropped-audio.mp4");
    const info = await mediaInfo(file);
    assert.equal(info.width, 160); assert.equal(info.height, 90); assert.equal(info.audio, true);
    assert.ok(Math.abs(info.duration - 2) <= 0.12, `出力時間: ${info.duration}`);
    assert.equal(info.frames, 24);
    const audio = runFfmpeg(["-v", "error", "-i", file, "-map", "0:a:0", "-f", "s16le", "pipe:1"], { encoding: null });
    assert.ok(audio.stdout.length > 48000, "音声を復号できません");
    let maximumAmplitude = 0;
    for (let index = 0; index + 1 < audio.stdout.length; index += 2) maximumAmplitude = Math.max(maximumAmplitude, Math.abs(audio.stdout.readInt16LE(index)));
    assert.ok(maximumAmplitude > 100, "音声の波形が失われています");
    return { ...info, maximumAudioAmplitude: maximumAmplitude };
  });
  await step("PNG 連番 ZIP の 24 枚・寸法・画像 decode", async () => {
    const file = await exportJob(/PNG連番保存/, "cropped-frames.zip");
    const entries = unzipSync(await readFile(file));
    const names = Object.keys(entries).sort();
    assert.equal(names.length, 24);
    for (const name of names) {
      const bytes = Buffer.from(entries[name]);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(bytes.readUInt32BE(16), 160); assert.equal(bytes.readUInt32BE(20), 90);
    }
    const first = path.join(downloadDirectory, "sequence-first.png"), last = path.join(downloadDirectory, "sequence-last.png");
    await writeFile(first, entries[names[0]]); await writeFile(last, entries[names.at(-1)]);
    await mediaInfo(first); await mediaInfo(last);
    return { count: names.length, names, width: 160, height: 90 };
  });
  await step("GIF の 15 FPS・寸法・区間と全フレーム decode", async () => {
    const file = await exportJob(/GIF アニメ保存/, "cropped.gif");
    const info = await mediaInfo(file);
    assert.equal(info.width, 160); assert.equal(info.height, 90); assert.equal(info.audio, false);
    assert.ok(Math.abs(info.duration - 2) <= 0.12, `GIF の時間: ${info.duration}`);
    assert.ok(info.frames >= 29 && info.frames <= 31, `GIF のフレーム数: ${info.frames}`);
    return info;
  });
  await step("現在 PNG 保存と TSV の日本語字幕・ポインター合成", async () => {
    await setCrop(0, 0, 320, 180);
    await seek(1.5);
    const before = await currentPng("overlay-off.png");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: /操作TSVを開く/ }).click();
    await (await chooser).setFiles(fixtures.input);
    await overlayEnabled(true);
    await page.getByText("Enter", { exact: false }).first().waitFor();
    const after = await currentPng("overlay-on.png");
    const info = await pngInfo(after);
    assert.equal(info.width, 320); assert.equal(info.height, 180);
    const plainPixels = await decodedPixels(before), overlaidPixels = await decodedPixels(after);
    assert.equal(plainPixels.length, overlaidPixels.length);
    // RGB/YUV の丸め誤差を字幕と誤認せず、視認できる大きさの画素差だけ数える。
    const changed = changedPixelCount(plainPixels, overlaidPixels);
    assert.ok(changed > 100, `合成による変更が見えません: ${changed} 画素`);
    await screenshot("japanese-overlay");
    await setCrop(16, 8, 160, 90);
    await overlayEnabled(false);
    const cropBefore = await currentPng("crop-subtitle-off.png");
    await page.getByRole("tab", { name: "字幕", exact: true }).click();
    await page.getByRole("checkbox", { name: "マウス・キー入力字幕を表示", exact: true }).setChecked(true);
    const cropAfter = await currentPng("crop-subtitle-on.png");
    const cropInfo = await pngInfo(cropAfter);
    assert.equal(cropInfo.width, 160); assert.equal(cropInfo.height, 90);
    const cropPlainPixels = await decodedPixels(cropBefore), cropSubtitlePixels = await decodedPixels(cropAfter);
    const bottomChanged = changedPixelCount(cropPlainPixels, cropSubtitlePixels, 160 * 45);
    assert.ok(bottomChanged > 100, `クロップ後の下半分に字幕が描画されていません: ${bottomChanged} 画素`);
    await writeFile(path.join(evidenceDirectory, "overlay-worker.log"), (await page.evaluate(() => window.__chulipTestWorkerLogs ?? [])).map(event => event.message).join("\n"), "utf8");
    return { ...info, changedPixels: changed, cropSubtitle: { ...cropInfo, bottomChangedPixels: bottomChanged }, note: "同一時刻の画像を比較し、日本語を含む操作 TSV の合成とクロップ後下部の字幕描画を検証。文字の外観は overlay-on.png と crop-subtitle-on.png を確認する。" };
  });
  await step("MP4・GIF・PNG連番のクロップ後字幕と開始時刻の補正", async () => {
    const output = [];
    for (const [button, filename, baseline] of [[/MP4 動画保存/, "subtitle.mp4", "cropped-audio.mp4"], [/GIF アニメ保存/, "subtitle.gif", "cropped.gif"]]) {
      const file = await exportJob(button, filename);
      const info = await mediaInfo(file);
      const plainFrame = path.join(downloadDirectory, `${baseline}-at-0.5.png`);
      const subtitleFrame = path.join(downloadDirectory, `${filename}-at-0.5.png`);
      for (const [input, frame] of [[path.join(downloadDirectory, baseline), plainFrame], [file, subtitleFrame]]) {
        runFfmpeg(["-v", "error", "-y", "-ss", "0.5", "-i", input, "-frames:v", "1", "-update", "1", frame]);
      }
      const changed = changedPixelCount(await decodedPixels(plainFrame), await decodedPixels(subtitleFrame), 160 * 45);
      assert.ok(changed > 100, `${filename} の字幕が出力されていません: ${changed} 画素`);
      assert.equal(info.width, 160); assert.equal(info.height, 90);
      output.push({ filename, ...info, bottomChangedPixels: changed });
    }
    const file = await exportJob(/PNG連番保存/, "subtitle-frames.zip");
    const plainEntries = unzipSync(await readFile(path.join(downloadDirectory, "cropped-frames.zip")));
    const subtitleEntries = unzipSync(await readFile(file));
    const names = Object.keys(subtitleEntries).sort();
    assert.equal(names.length, 24);
    const plainFrame = path.join(downloadDirectory, "sequence-at-0.5.png"), subtitleFrame = path.join(downloadDirectory, "subtitle-sequence-at-0.5.png");
    await writeFile(plainFrame, plainEntries[names[6]]); await writeFile(subtitleFrame, subtitleEntries[names[6]]);
    const changed = changedPixelCount(await decodedPixels(plainFrame), await decodedPixels(subtitleFrame), 160 * 45);
    assert.ok(changed > 100, `PNG連番の字幕が出力されていません: ${changed} 画素`);
    output.push({ filename: "subtitle-frames.zip", count: names.length, bottomChangedPixels: changed });
    return output;
  });
  await step("設定保存・再読込・同一動画の再選択による復元", async () => {
    await setRange(1, 3); await setCrop(16, 8, 160, 90);
    await page.getByLabel("再生速度", { exact: true }).fill("1.5");
    await page.getByTitle("設定を保存", { exact: true }).click();
    await page.getByText("設定を保存しました", { exact: true }).waitFor();
    await seek(2.5);
    await page.getByTitle("設定を再読込", { exact: true }).click();
    await page.getByText("動画を読み込みました", { exact: true }).waitFor({ timeout: 120000 });
    await page.waitForFunction(() => Math.abs((document.querySelector("video")?.currentTime ?? -10) - 1.5) < 0.05);
    await page.reload({ waitUntil: "networkidle" });
    await openVideo(fixtures.audio);
    for (const [label, value] of [["開始秒", 1], ["終了秒", 3], ["クロップX", 16], ["クロップY", 8], ["クロップ幅", 160], ["クロップ高さ", 90], ["再生速度", 1.5]]) {
      assert.equal(Number(await page.getByLabel(label, { exact: true }).inputValue()), value, `復元された ${label}`);
    }
    await page.waitForFunction(() => Math.abs((document.querySelector("video")?.currentTime ?? -10) - 1.5) < 0.05);
    return { range: [1, 3], crop: [16, 8, 160, 90], speed: 1.5, currentTime: 1.5, sameFileReload: true };
  });
  await step("実時間で再生が進み、全体と選択区間の終端を越えてループする", async () => {
    await page.getByRole("checkbox", { name: "区間再生", exact: true }).setChecked(false);
    await page.getByRole("checkbox", { name: "ループ再生", exact: true }).setChecked(false);
    await page.getByLabel("再生速度", { exact: true }).fill("1.5");
    await seek(0.25);
    await page.getByRole("button", { name: "▲ 再生", exact: true }).click();
    const normal = await samplePlayback(4);
    await page.getByRole("button", { name: "■ 停止", exact: true }).click();
    assert.ok(normal.at(-1).currentTime - normal[0].currentTime > 0.7, `実時間の再生が進みません: ${JSON.stringify(normal)}`);
    assert.ok(normal.every(sample => !sample.paused && sample.playbackRate === 1.5));
    await page.getByRole("checkbox", { name: "ループ再生", exact: true }).setChecked(true);
    await seek(4.75);
    await page.getByRole("button", { name: "▲ 再生", exact: true }).click();
    const wholeLoop = await samplePlayback(8);
    await page.getByRole("button", { name: "■ 停止", exact: true }).click();
    const wholeWrap = wholeLoop.findIndex((sample, index) => index > 0 && sample.currentTime < wholeLoop[index - 1].currentTime - 1);
    assert.ok(wholeWrap > 0, `動画終端から先頭へ戻りません: ${JSON.stringify(wholeLoop)}`);
    assert.ok(wholeLoop.at(-1).currentTime > wholeLoop[wholeWrap].currentTime + 0.5);
    assert.equal(wholeLoop.at(-1).paused, false, "全体ループの折り返しで停止しました");
    await page.getByRole("checkbox", { name: "区間再生", exact: true }).setChecked(true);
    await setRange(1, 3); await seek(2.75);
    await page.getByRole("button", { name: "▲ 再生", exact: true }).click();
    const rangeLoop = await samplePlayback(12);
    await page.getByRole("button", { name: "■ 停止", exact: true }).click();
    const rangeWraps = rangeLoop.filter((sample, index) => index > 0 && sample.currentTime < rangeLoop[index - 1].currentTime - 0.5).length;
    assert.ok(rangeWraps >= 2, `選択区間のループを繰り返しません: ${JSON.stringify(rangeLoop)}`);
    assert.ok(rangeLoop.every(sample => sample.currentTime >= 0.98 && sample.currentTime <= 3.3), "区間外へ再生が進みました");
    assert.equal(rangeLoop.at(-1).paused, false, "区間ループの折り返しで停止しました");
    await page.getByRole("checkbox", { name: "区間再生", exact: true }).setChecked(false);
    await page.getByRole("checkbox", { name: "ループ再生", exact: true }).setChecked(false);
    return { normal, wholeLoop, rangeLoop, wholeWrap, rangeWraps };
  });
  await step("実行中のキャンセルと次ジョブの再ロード・成功", async () => {
    await setRange(0, 5); await setCrop(0, 0, 320, 180); await overlayEnabled(false);
    await page.getByRole("tab", { name: "画像保存", exact: true }).click();
    await page.getByRole("button", { name: /PNG連番保存/ }).click();
    const job = page.locator(".export-job").first();
    await page.locator(".export-job.state-running").first().waitFor({ timeout: 30000 });
    await job.getByRole("button", { name: "キャンセル", exact: true }).click();
    await page.locator(".export-job.state-cancelled").first().waitFor({ timeout: 30000 });
    await setRange(1, 3); await setCrop(16, 8, 160, 90);
    const next = await exportJob(/MP4 動画保存/, "after-cancel.mp4");
    const info = await mediaInfo(next);
    assert.equal(info.frames, 24); assert.equal(info.audio, true);
    return { cancelled: true, next: info };
  });
  await step("無音動画の MP4 出力", async () => {
    await openVideo(fixtures.silent); await setRange(1, 3); await setCrop(16, 8, 160, 90);
    const file = await exportJob(/MP4 動画保存/, "silent.mp4");
    const info = await mediaInfo(file);
    assert.equal(info.audio, false); assert.equal(info.width, 160); assert.equal(info.height, 90); assert.equal(info.frames, 24);
    return info;
  });
  await step("破損動画のエラー表示後に正常動画を再選択して復旧", async () => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: /動画を開く/ }).click();
    await (await chooser).setFiles(fixtures.broken);
    await page.getByText(/動画処理に失敗|動画情報.*失敗|動画情報.*読み取れ|映像ストリーム/).first().waitFor({ timeout: 120000 });
    await screenshot("broken-file-error");
    await openVideo(fixtures.audio);
    await seek(1);
    const image = await currentPng("after-broken-recovery.png");
    return pngInfo(image);
  });
  await step("1365x900 の操作ボタン配置", () => geometry(1365, 900));
  await step("900x700 の操作ボタン配置", () => geometry(900, 700));
  await step("動画送信・外部 origin 通信・実行時例外がないこと", async () => {
    const external = results.requests.filter(request => new URL(request.url).origin !== expectedOrigin);
    const mutation = results.requests.filter(request => !["GET", "HEAD", "OPTIONS"].includes(request.method));
    assert.deepEqual(external, [], "外部 origin への通信が発生しました");
    assert.deepEqual(mutation, [], "動画送信につながる通信が発生しました");
    assert.deepEqual(results.pageErrors, [], "ブラウザ内の未処理例外が発生しました");
    return { requests: results.requests.length, externalRequests: external.length, nonReadRequests: mutation.length, pageErrors: results.pageErrors.length };
  });
  await page.setViewportSize({ width: 1365, height: 1050 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const editor = document.querySelector(".browser-editor");
    if (editor) editor.scrollTop = 0;
  });
  results.overviewScreenshot = await screenshot("main-overview-1365x1050");
  results.status = "passed";
  console.log(`ブラウザ検証成功: ${results.steps.length} 項目`);
} catch (error) {
  results.status = "failed";
  results.error = error instanceof Error ? error.stack : String(error);
  console.error(results.error);
  if (page) {
    try { await screenshot("failure"); } catch { /* ブラウザ終了時は JSON だけ残す。 */ }
    try { await writeFile(path.join(evidenceDirectory, "failure-page.html"), await page.content(), "utf8"); } catch { /* 同上 */ }
    try { await writeFile(path.join(evidenceDirectory, "wasm-worker.log"), (await page.evaluate(() => window.__chulipTestWorkerLogs ?? [])).map(event => event.message).join("\n"), "utf8"); } catch { /* 同上 */ }
    try { await writeFile(path.join(evidenceDirectory, "ass-files.json"), JSON.stringify(await page.evaluate(() => window.__chulipTestAssFiles ?? {}), null, 2), "utf8"); } catch { /* 同上 */ }
  }
  process.exitCode = 1;
} finally {
  results.finishedAt = new Date().toISOString();
  if (page) {
    try { await writeFile(path.join(evidenceDirectory, "wasm-worker.log"), (await page.evaluate(() => window.__chulipTestWorkerLogs ?? [])).map(event => event.message).join("\n"), "utf8"); } catch { /* ブラウザを開けない場合は結果 JSON を残す。 */ }
  }
  if (context) await context.close();
  if (browser) await browser.close();
  await mkdir(evidenceDirectory, { recursive: true });
  await saveResults();
  await writeFile(path.join(evidenceRoot, "latest-browser-run.json"), JSON.stringify({ status: results.status, directory: evidenceDirectory, results: path.join(evidenceDirectory, "browser-results.json") }, null, 2), "utf8");
  if (results.error) await writeFile(path.join(evidenceDirectory, "browser-error.log"), results.error, "utf8");
}
