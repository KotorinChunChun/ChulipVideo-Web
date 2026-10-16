import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createFixtures, evidenceDirectory } from "./create-web-fixtures.mjs";

const { chromium, webkit } = createRequire(import.meta.url)("playwright");
const engine = process.env.CHULIP_TEST_ENGINE ?? "chromium";
const directory = path.join(evidenceDirectory, `mobile-${engine}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(directory, { recursive: true });
const fixtures = await createFixtures();
console.log(`モバイル検証開始: ${engine}`);
const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chrome" }));
const context = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ...(engine === "webkit" ? {} : { recordVideo: { dir: path.join(directory, "recordings") } }) });
console.log("検証ページを作成");
const page = await context.newPage();
const results = [];
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
try {
  await page.goto(process.env.CHULIP_WEB_URL ?? "http://127.0.0.1:1421");
  console.log("検証動画を選択");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "動画を開く", exact: true }).click();
  await (await chooser).setFiles(fixtures.audio);
  await page.getByText("動画を読み込みました", { exact: true }).waitFor({ timeout: 120000 });
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  for (const size of [{ width: 390, height: 664 }, { width: 375, height: 600 }]) {
    await page.setViewportSize(size);
    for (const tab of ["時間", "切り抜き", "字幕", "画像保存", "動画保存"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      assert.equal(await page.getByRole("tab", { name: tab, exact: true }).getAttribute("aria-selected"), "true");
      const layout = await page.evaluate(() => {
        const shell = document.querySelector(".browser-editor");
        const video = document.querySelector(".video-stage").getBoundingClientRect();
        const buttons = [...document.querySelectorAll(".transport-buttons button")].map(b => { const r = b.getBoundingClientRect(); return { y: r.y, right: r.right }; });
        const panels = document.querySelector(".editing-panels").getBoundingClientRect();
        return { scroll: shell.scrollHeight - shell.clientHeight, width: shell.scrollWidth, viewport: innerWidth, videoBottom: video.bottom, videoTop: video.top, buttons, panelBottom: panels.bottom, panelHeight: panels.height, height: innerHeight };
      });
      assert.ok(layout.scroll <= 1, `ページスクロール: ${JSON.stringify(layout)}`);
      assert.ok(layout.width <= layout.viewport);
      assert.equal(new Set(layout.buttons.map(b => Math.round(b.y))).size, 1);
      assert.ok(layout.buttons.every(b => b.right <= layout.viewport));
      assert.ok(layout.videoTop >= 0 && layout.videoBottom < layout.height);
      assert.ok(layout.panelBottom <= layout.height + 1 && layout.panelHeight > 100);
      results.push({ size, tab, layout });
      await page.screenshot({ path: path.join(directory, `${size.width}-${tab}.png`) });
    }
  }
  const slider = page.getByRole("slider", { name: "シーク", exact: true });
  const box = await slider.boundingBox();
  // 実ブラウザのタッチイベントをPointerEventへ変換する経路を検証する。
  if (engine === "chromium") {
    const session = await context.newCDPSession(page);
    const point = fraction => ({ x: box.x + 10 + (box.width - 20) * fraction, y: box.y + box.height / 2 });
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(0.2)] });
    for (const fraction of [0.35, 0.5, 0.7]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(fraction)] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(box.x + 10 + (box.width - 20) * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 10 + (box.width - 20) * 0.7, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
  }
  const position = await slider.inputValue();
  assert.ok(Number(position) > 3.3 && Number(position) < 3.7, position);
  await page.waitForFunction(() => Math.abs(document.querySelector("video").currentTime - 3.5) < 0.15);
  await page.getByRole("tab", { name: "時間", exact: true }).click();
  await page.getByRole("button", { name: "現在位置を開始に", exact: true }).click();
  assert.ok(Number(await page.getByLabel("開始秒", { exact: true }).inputValue()) > 3.3);
  await page.screenshot({ path: path.join(directory, "timeline-drag.png") });
  assert.deepEqual(errors, []);
  console.log(`モバイル検証成功: ${engine} / 2画面幅×5タブ / タイムラインドラッグ / ${directory}`);
} finally {
  await context.close(); await browser.close();
  await writeFile(path.join(directory, "results.json"), JSON.stringify({ engine, results, errors }, null, 2));
}
