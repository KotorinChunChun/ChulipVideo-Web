import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBrowserCrop, type BrowserCrop } from "./crop";

const image = { width: 320, height: 180 };
const crop: BrowserCrop = { x: 20, y: 30, width: 80, height: 60 };

test("右下へ移動しても枠を縮めず、左上座標だけを映像端に制限する", () => {
  assert.deepEqual(normalizeBrowserCrop({ ...crop, x: 310, y: 170 }, crop, image, "未指定", false), { x: 240, y: 120, width: 80, height: 60 });
  assert.deepEqual(normalizeBrowserCrop({ ...crop, x: -30, y: -20 }, crop, image, "未指定", false), { ...crop, x: 0, y: 0 });
});

test("比率を選択した直後の移動でも、編集前の幅と高さは変えない", () => {
  assert.deepEqual(normalizeBrowserCrop({ ...crop, x: 300, y: 180 }, crop, image, "1:1", false), { x: 240, y: 120, width: 80, height: 60 });
});

test("1:1 の幅 300 は 320×180 の映像内で 180×180 になる", () => {
  const current = { x: 0, y: 0, width: 320, height: 180 };
  assert.deepEqual(normalizeBrowserCrop({ ...current, width: 300, height: 300 }, current, image, "1:1", false), { x: 0, y: 0, width: 180, height: 180 });
});

test("固定比率の大きな解像度プリセットを同倍率で内接させる", () => {
  const current = { x: 0, y: 0, width: 100, height: 80 };
  assert.deepEqual(normalizeBrowserCrop({ ...current, width: 1920, height: 1080 }, current, image, "16:9", false), { x: 0, y: 0, width: 320, height: 180 });
  assert.deepEqual(normalizeBrowserCrop({ ...current, width: 1920, height: 1080 }, current, image, "1:1", false), { x: 0, y: 0, width: 180, height: 180 });
});

test("左上座標を保持した拡縮でも、残りの幅と高さに同倍率で収める", () => {
  const current = { x: 100, y: 20, width: 80, height: 60 };
  assert.deepEqual(normalizeBrowserCrop({ ...current, width: 400, height: 300 }, current, image, "4:3", false), { x: 100, y: 20, width: 213, height: 160 });
});

test("比率未指定では幅・高さをそれぞれ制限できる", () => {
  const current = { x: 0, y: 0, width: 100, height: 80 };
  assert.deepEqual(normalizeBrowserCrop({ ...current, width: 300, height: 300 }, current, image, "未指定", false), { x: 0, y: 0, width: 300, height: 180 });
});

test("数値入力で幅から計算した高さの丸めを基準に幅を再計算しない", () => {
  const current = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(normalizeBrowserCrop({ ...current, width: 501, height: 282 }, current, { width: 1920, height: 1080 }, "16:9", false), { x: 0, y: 0, width: 501, height: 282 });
  assert.deepEqual(normalizeBrowserCrop({ ...current, width: 535, height: 301 }, current, { width: 1920, height: 1080 }, "16:9", false), { x: 0, y: 0, width: 535, height: 301 });
});

test("幅だけを変えるドラッグでは比率に沿って高さも調整する", () => {
  const current = { x: 0, y: 0, width: 100, height: 80 };
  assert.deepEqual(normalizeBrowserCrop({ ...current, width: 200 }, current, image, "16:9", false), { x: 0, y: 0, width: 200, height: 113 });
});

test("枠外選択が有効なら負座標・映像より大きい寸法を保持する", () => {
  assert.deepEqual(normalizeBrowserCrop({ x: -40, y: -20, width: 300, height: 300 }, crop, image, "1:1", true), { x: -40, y: -20, width: 300, height: 300 });
  assert.deepEqual(normalizeBrowserCrop({ ...crop, x: 400, y: -30 }, crop, image, "1:1", true), { ...crop, x: 400, y: -30 });
});

test("枠外から戻した大きな枠を移動すると、元の形を保って映像へ収める", () => {
  const current = { x: -20, y: -30, width: 400, height: 300 };
  assert.deepEqual(normalizeBrowserCrop({ ...current, x: 20 }, current, image, "16:9", false), { x: 20, y: 0, width: 240, height: 180 });
});

test("小さい映像や端での丸めでも正の寸法かつ映像内に収まる", () => {
  const current = { x: 0, y: 0, width: 2, height: 2 };
  assert.deepEqual(normalizeBrowserCrop({ x: 3, y: 4, width: 10, height: 10 }, current, { width: 1, height: 1 }, "1:1", false), { x: 0, y: 0, width: 1, height: 1 });
  for (const ratio of ["1:1", "4:3", "16:9", "9:16"]) {
    for (const x of [-10, 0, 100, 319]) {
      const adjusted = normalizeBrowserCrop({ x, y: 179, width: 500, height: 500 }, current, image, ratio, false);
      assert.ok(adjusted.x >= 0 && adjusted.y >= 0 && adjusted.width >= 1 && adjusted.height >= 1);
      assert.ok(adjusted.x + adjusted.width <= image.width && adjusted.y + adjusted.height <= image.height);
    }
  }
});

test("入力オブジェクトを変更せず、非有限値の編集を採用しない", () => {
  const current = Object.freeze({ ...crop });
  const next = Object.freeze({ ...crop, width: 200 });
  normalizeBrowserCrop(next, current, image, "1:1", false);
  assert.deepEqual(next, { ...crop, width: 200 });
  assert.deepEqual(normalizeBrowserCrop({ ...crop, x: NaN }, current, image, "1:1", false), crop);
});
