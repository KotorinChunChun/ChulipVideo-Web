export type BrowserCrop = { x: number; y: number; width: number; height: number };
type ImageSize = { width: number; height: number };

function aspectRatio(value: string): number | null {
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const [width, height] = parts.map(Number);
  const ratio = width / height;
  return width > 0 && height > 0 && Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

/** Web の枠編集。移動時は寸法を保ち、比率付きの拡縮は同倍率で映像内へ収める。 */
export function normalizeBrowserCrop(
  next: BrowserCrop,
  current: BrowserCrop,
  image: ImageSize,
  ratio: string,
  allowOversize: boolean,
): BrowserCrop {
  if (!Object.values(next).every(Number.isFinite) || ![image.width, image.height].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return { ...current };
  }
  const resizing = Math.abs(next.width - current.width) > 0.1 || Math.abs(next.height - current.height) > 0.1;
  let width = resizing ? Math.max(2, next.width) : current.width;
  let height = resizing ? Math.max(2, next.height) : current.height;
  const aspect = resizing ? aspectRatio(ratio) : null;
  if (aspect !== null) {
    // 数値入力は変更した側を基準に他方を計算済み。その丸め値を再解釈しない。
    const alreadyAdjusted = Math.abs(height - width / aspect) <= 0.500001 || Math.abs(width - height * aspect) <= 0.500001;
    if (!alreadyAdjusted) {
      const byWidth = Math.abs(next.width - current.width) >= Math.abs(next.height - current.height);
      if (byWidth) height = width / aspect;
      else width = height * aspect;
    }
  }
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return { ...current };

  let x = Math.round(next.x);
  let y = Math.round(next.y);
  if (!allowOversize) {
    if (!resizing) {
      // 枠外設定で作った大きな枠だけは、まず現在の形を保って映像へ収める。
      const scale = Math.min(1, image.width / width, image.height / height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      x = clamp(x, 0, image.width - width);
      y = clamp(y, 0, image.height - height);
    } else {
      x = clamp(x, 0, Math.max(0, image.width - 2));
      y = clamp(y, 0, Math.max(0, image.height - 2));
      const availableWidth = image.width - x;
      const availableHeight = image.height - y;
      if (aspect !== null) {
        const scale = Math.min(1, availableWidth / width, availableHeight / height);
        width *= scale;
        height *= scale;
      } else {
        width = Math.min(width, availableWidth);
        height = Math.min(height, availableHeight);
      }
    }
  }
  return { x, y, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}
