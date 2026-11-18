import { creditHeight, drawCredits } from './snapshot.js';

// Optional AI upscaling (ESRGAN via UpscalerJS + TensorFlow.js), loaded only on demand.
// The network invents plausible detail; it does not recover what the satellite did not see.

const CDN = 'https://cdn.jsdelivr.net/npm/';
const SCRIPTS = [
  ['@tensorflow/tfjs@4.11.0/dist/tf.min.js', 'sha384-KYxi/8db1ZZ+jkQnI7O2gXy6cVtDB5E8I0ZJvQ2wpL6HODnx5LpTVMe0hD4posna'],
  ['upscaler@1.0.0/dist/browser/umd/upscaler.min.js', 'sha384-QMCS4oRU0yhc/triRbY4mcIreg38XzA/8NNuZfTWWvv/km8cX/L63yLb3hh0IaA3']
];
const MODELS = {
  2: ['@upscalerjs/esrgan-medium@1.0.0/dist/umd/models/esrgan-medium/src/x2/index.min.js', 'sha384-NScIcbitHB2f44lnOmmm8RBZ50zbE6jrBoCy6mXOkYIM937WU3XbgqjR2g4n/YcP', 'ESRGANMedium2x'],
  4: ['@upscalerjs/esrgan-medium@1.0.0/dist/umd/models/esrgan-medium/src/x4/index.min.js', 'sha384-5fJ01HD6+MUDQcTDVhBsqg1yPTfOJb6urBcnZ13EqPInN+9vUsTnoaN56Wlg1x9d', 'ESRGANMedium4x']
};
// Output must stay within browser canvas limits and a reasonable GPU memory budget.
export const MAX_OUTPUT_PIXELS = 12_000_000;

export function enhanceLimit(width, height, scale) {
  return width * height * scale * scale <= MAX_OUTPUT_PIXELS;
}

const loaded = new Map();
function loadScript(path, integrity) {
  if (!loaded.has(path)) loaded.set(path, new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CDN + path;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = () => { loaded.delete(path); script.remove(); reject(new Error('Не вдалося завантажити модуль ШІ. Перевірте з’єднання.')); };
    document.head.append(script);
  }));
  return loaded.get(path);
}

const upscalers = new Map();
async function upscalerFor(scale) {
  for (const [path, integrity] of SCRIPTS) await loadScript(path, integrity);
  const [path, integrity, name] = MODELS[scale];
  await loadScript(path, integrity);
  if (!upscalers.has(scale)) upscalers.set(scale, new window.Upscaler({ model: window[name] }));
  return upscalers.get(scale);
}

/** Upscales an image blob ×2 or ×4. Returns a JPEG blob. */
export async function enhancePhoto(blob, { scale = 2, imageHeight, credits = '', signal, onProgress } = {}) {
  if (!MODELS[scale]) throw new Error('Підтримується лише ×2 або ×4');
  const bitmap = await createImageBitmap(blob);
  try {
    // The credits strip is redrawn afterwards instead of being upscaled.
    const height = Math.min(bitmap.height, imageHeight || bitmap.height);
    if (!enhanceLimit(bitmap.width, height, scale)) {
      throw new Error(`Фото завелике для ШІ ×${scale}. Наблизьте карту сильніше й зробіть нове фото.`);
    }
    onProgress?.(0, 'Завантажуємо модель…');
    const upscaler = await upscalerFor(scale);
    const input = document.createElement('canvas');
    input.width = bitmap.width;
    input.height = height;
    input.getContext('2d').drawImage(bitmap, 0, 0);
    const tensor = await upscaler.upscale(input, {
      // No awaitNextFrame: animation frames stall in background tabs.
      output: 'tensor', patchSize: 128, padding: 8, signal,
      progress: rate => onProgress?.(rate, `Обробка ${Math.round(rate * 100)}%`)
    });
    const tf = window.tf;
    const pixels = tf.tidy(() => tensor.clipByValue(0, 255).round().cast('int32'));
    tensor.dispose();
    const image = document.createElement('canvas');
    await tf.browser.toPixels(pixels, image);
    pixels.dispose();
    const strip = credits ? creditHeight(image.width) : 0;
    const output = document.createElement('canvas');
    output.width = image.width;
    output.height = image.height + strip;
    const context = output.getContext('2d');
    context.drawImage(image, 0, 0);
    if (strip) drawCredits(context, image.width, image.height, strip, credits);
    return await new Promise((resolve, reject) => output.toBlob(result => result ? resolve(result) : reject(new Error('Браузер не зміг створити зображення')), 'image/jpeg', 0.92));
  } finally {
    bitmap.close?.();
  }
}
