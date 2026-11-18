import { validateKey } from './credentials.js';
import { tileCoordinates } from './catalog.js';

export async function checkConnection(source, value, { center = { lat: 50.4501, lng: 30.5234 }, zoom = 14, signal, fetcher = fetch, timeoutMs = 12000 } = {}) {
  const key = validateKey(source, value);
  if (!key) throw new Error('Спочатку вставте власний ключ.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  const request = async (url, method = 'GET') => {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = await fetcher(url, { method, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!response.ok) {
      const error = new Error(response.status === 429 ? 'Сервіс обмежив запити (429). Повторіть пізніше.'
        : response.status === 401 ? 'Ключ не прийнято (401). Перевірте його в кабінеті сервісу.'
        : response.status === 403 ? 'Доступ не дозволено (403). Перевірте тариф і обмеження ключа за доменом.'
        : response.status === 402 ? 'Потрібні доступний баланс або відповідний тариф (402).'
        : `Сервіс повернув HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return response;
  };
  try {
    if (source === 'gamma') {
      const response = await request(`https://api.gamma.earth/jobs/${encodeURIComponent(key)}?limit=1`);
      const data = await response.json();
      const balance = data.credits?.total_balance;
      if (typeof balance !== 'number' || !Number.isFinite(balance)) throw new Error('Gamma Earth не повернув баланс. Перевірте доступ до API для свого тарифу.');
      return { message: `Підключено · ${balance.toLocaleString('uk-UA')} кредитів. Обробку не запускали.`, balance };
    }
    const tile = tileCoordinates(center, Math.min(zoom, 16));
    let url;
    if (source === 'mapbox') {
      await request(`https://api.mapbox.com/v4/mapbox.satellite.json?access_token=${encodeURIComponent(key)}`);
      url = `https://api.mapbox.com/v4/mapbox.satellite/${tile.level}/${tile.column}/${tile.row}.jpg90?access_token=${encodeURIComponent(key)}`;
    } else {
      const response = await request(`https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${encodeURIComponent(key)}`);
      const data = await response.json();
      const template = data.tiles?.[0];
      if (typeof template !== 'string') throw new Error('MapTiler не надав супутникового покриття для цього ключа.');
      url = template.replace('{key}', encodeURIComponent(key)).replace('{z}', tile.level).replace('{x}', tile.column).replace('{y}', tile.row);
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.maptiler.com' || parsed.username || parsed.password) throw new Error('MapTiler повернув непідтримувану адресу зображення.');
    }
    // A TileJSON response alone is insufficient: Mapbox can still refuse imagery.
    try { await request(url, 'HEAD'); }
    catch (error) {
      if (![405, 501].includes(error.status)) throw error;
      await request(url);
    }
    return { message: 'Підключено · супутникові зображення доступні.' };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timedOut) throw new Error('Сервіс не відповів вчасно. Спробуйте ще раз.');
    if (error instanceof TypeError) throw new Error('Не вдалося з’єднатися із сервісом. Перевірте мережу та доступ за доменом.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
