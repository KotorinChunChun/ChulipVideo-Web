import assert from "node:assert/strict";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createFixtures, evidenceDirectory, runFfmpeg } from "./create-web-fixtures.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const directory = path.join(evidenceDirectory, `mkv-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(directory, { recursive: true });
const fixtures = await createFixtures();
const small = path.join(directory, "ドロップ確認.MKV");
const large = path.join(directory, "513MiB確認.mkv");
runFfmpeg(["-y", "-i", fixtures.audio, "-c", "copy", small]);
// 5秒の合成MKVへEBML Void（空のパディング）を加え、実容量で旧上限を越す。
// 長時間・高解像度動画の処理限界を示す素材ではない。
runFfmpeg(["-y", "-i", fixtures.audio, "-c", "copy", large]);
const size = (await stat(large)).size;
const targetBytes = 513 * 1024 * 1024;
const handle = await open(large, "r+");
try {
  const header = Buffer.alloc(9);
  header[0] = 0xec;
  header.writeBigUInt64BE((1n << 56n) | BigInt(targetBytes - size - 9), 1);
  await handle.write(header, 0, header.length, size);
  await handle.truncate(targetBytes);
} finally { await handle.close(); }

const results = { status: "running", steps: [], errors: [], requests: [] };
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 600 }, acceptDownloads: true, recordVideo: { dir: path.join(directory, "recordings") } });
const page = await context.newPage();
page.on("pageerror", error => results.errors.push(String(error)));
page.on("request", request => { if (/^https?:/.test(request.url())) results.requests.push({ url: request.url(), method: request.method() }); });
try {
  await page.goto(process.env.CHULIP_WEB_URL ?? "http://127.0.0.1:1421");
  for (const [file, mime] of [[small, ""], [large, "video/x-matroska"]]) {
    console.log(`MKVドロップ確認: ${path.basename(file)}`);
    // Fileを実ディスクから読み込み、ドロップのDataTransferへ渡す。
    await page.evaluate(() => {
      const input = document.createElement("input"); input.type = "file"; input.id = "test-drop-file"; input.hidden = true; document.body.append(input);
    });
    await page.locator("#test-drop-file").setInputFiles(file);
    const oldUrl = await page.locator("video").count() ? await page.locator("video").getAttribute("src") : null;
    const transfer = await page.evaluateHandle(mime => {
      const input = document.querySelector("#test-drop-file");
      const original = input.files[0];
      const dt = new DataTransfer(); dt.items.add(new File([original], original.name, { type: mime, lastModified: original.lastModified })); input.remove();
      return dt;
    }, mime);
    await page.locator(".video-stage").dispatchEvent("dragover", { dataTransfer: transfer });
    await page.locator(".video-stage").dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await page.waitForFunction(old => {
      const video = document.querySelector("video"); return video && video.getAttribute("src") !== old && video.readyState >= 2;
    }, oldUrl, { timeout: 180000 });
    await page.getByText("動画を読み込みました", { exact: true }).waitFor();
    await page.getByRole("button", { name: "▲ 再生", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("video").currentTime > 0.5);
    await page.getByRole("button", { name: "■ 停止", exact: true }).click();
    await page.getByLabel("シーク", { exact: true }).fill("1.5");
    await page.waitForFunction(() => Math.abs(document.querySelector("video").currentTime - 1.5) < 0.1);
    await page.getByRole("tab", { name: "時間", exact: true }).click();
    await page.getByLabel("終了秒", { exact: true }).fill("2");
    await page.getByLabel("開始秒", { exact: true }).fill("1");
    await page.getByRole("tab", { name: "動画保存", exact: true }).click();
    const previous = await page.locator(".export-job").count() ? await page.locator(".export-job").first().getAttribute("data-job-id") : null;
    await page.getByRole("button", { name: /MP4 動画保存/ }).click();
    await page.waitForFunction(old => { const job = document.querySelector(".export-job"); return job && job.getAttribute("data-job-id") !== old; }, previous);
    const job = page.locator(".export-job").first();
    await job.getByRole("link", { name: "ダウンロード", exact: true }).waitFor({ timeout: 180000 });
    const downloading = page.waitForEvent("download"); await job.getByRole("link", { name: "ダウンロード", exact: true }).click();
    const output = path.join(directory, `${path.basename(file)}-clip.mp4`); await (await downloading).saveAs(output);
    const decode = runFfmpeg(["-i", output, "-f", "null", "-"]);
    assert.match(decode.stderr, /Video: h264/); assert.match(decode.stderr, /Audio: aac/); assert.match(decode.stderr, /320x180/);
    results.steps.push({ file: path.basename(file), bytes: (await stat(file)).size, mime, status: "passed", output });
  }
  for (const viewport of [{ width: 1365, height: 768 }, { width: 1280, height: 600 }, { width: 900, height: 600 }]) {
    await page.setViewportSize(viewport);
    for (const name of ["時間", "切り抜き", "字幕", "画像保存", "動画保存"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      const geometry = await page.evaluate(() => {
        const shell = document.querySelector(".browser-editor"), preview = document.querySelector(".video-stage").getBoundingClientRect(), panels = document.querySelector(".editing-panels").getBoundingClientRect();
        return { overflow: shell.scrollHeight - shell.clientHeight, width: shell.scrollWidth, height: innerHeight, previewBottom: preview.bottom, panelBottom: panels.bottom, visiblePanels: [...document.querySelectorAll(".trim-panel,.crop-panel,.export-section")].filter(p => p.getClientRects().length).length };
      });
      assert.ok(geometry.overflow <= 1 && geometry.width <= viewport.width);
      assert.ok(geometry.previewBottom < viewport.height && geometry.panelBottom <= viewport.height + 1);
      assert.equal(geometry.visiblePanels, 1);
      results.steps.push({ viewport, tab: name, geometry, status: "passed" });
    }
  }
  await page.getByRole("tab", { name: "時間", exact: true }).click();
  await page.screenshot({ path: path.join(directory, "pc-tabs.png") });
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.requests.filter(r => !["GET", "HEAD"].includes(r.method)), []);
  results.status = "passed";
  console.log(`MKV・513MiB・PCタブ検証成功: ${directory}`);
} catch (error) {
  results.status = "failed"; results.error = String(error); await page.screenshot({ path: path.join(directory, "failure.png") }); throw error;
} finally {
  await context.close(); await browser.close(); await writeFile(path.join(directory, "results.json"), JSON.stringify(results, null, 2));
}
