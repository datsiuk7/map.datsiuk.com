import { capturePhoto, thumbnail } from './snapshot.js';
import { createSnapshotStore, HISTORY_LIMITS } from './snapshot-store.js';

const $ = id => document.getElementById(id);
const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`;
const stamp = time => new Date(time).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fileName = record => {
  const date = new Date(record.createdAt);
  const pad = number => String(number).padStart(2, '0');
  const time = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const label = `${record.provider}-${record.label}`.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/giu, '-').replace(/^-|-$/g, '');
  return `map-${label}-${time}.jpg`;
};

export function describePhoto(record) {
  const parts = [`${record.width}×${record.height}`];
  if (record.kind === 'ai') parts.push(`ШІ ×${record.scale} · деталі домальовано`);
  else {
    parts.push(`рівень ${record.captureZoom}`);
    if (record.gain > 1) parts.push(`×${record.gain} до екрана`);
    if (record.metersPerPixel) parts.push(`крок тайлів ≈ ${record.metersPerPixel < 1 ? record.metersPerPixel.toFixed(2).replace('.', ',') : Math.round(record.metersPerPixel)} м`);
    if (record.tiles?.fallback) parts.push(`${record.tiles.fallback} тайл. з нижчого рівня`);
  }
  return parts.join(' · ');
}

export function setupPhotos({ getTargets, showStatus, onShowOnMap }) {
  const store = createSnapshotStore();
  const dialog = $('photosDialog'), list = $('photoList'), viewer = $('photoViewer'), frame = $('viewerFrame');
  const photoButton = $('photoButton'), photoLabel = photoButton.innerHTML;
  const thumbUrls = [];
  let viewerUrl = null, current = null, capturing = null, enhancing = null;

  const refreshCount = async () => {
    const records = await store.list().catch(() => []);
    $('historyCount').textContent = records.length ? String(records.length) : '';
    return records;
  };

  async function render() {
    const records = await refreshCount();
    for (const url of thumbUrls.splice(0)) URL.revokeObjectURL(url);
    list.replaceChildren(...records.map(record => {
      const item = document.createElement('li');
      item.className = 'photo-card';
      item.setAttribute('aria-current', String(record.id === current?.id));
      const button = document.createElement('button');
      button.type = 'button';
      const image = document.createElement('img');
      const url = URL.createObjectURL(record.thumb || record.blob);
      thumbUrls.push(url);
      image.src = url;
      image.alt = '';
      image.loading = 'lazy';
      const title = document.createElement('span');
      title.textContent = `${record.title} · ${record.label}`;
      const meta = document.createElement('small');
      meta.textContent = `${describePhoto(record)} · ${stamp(record.createdAt)}`;
      button.append(image, title, meta);
      button.addEventListener('click', () => show(record));
      item.append(button);
      return item;
    }));
    $('photosEmpty').hidden = records.length > 0;
    const bytes = records.reduce((sum, record) => sum + (record.bytes || 0), 0);
    $('photosUsage').textContent = records.length
      ? `${records.length} з ${HISTORY_LIMITS.maxEntries} · ${megabytes(bytes)}${store.persistent ? '' : ' · лише до закриття вкладки'}`
      : '';
    $('clearPhotos').hidden = !records.length;
    if (current && !records.some(record => record.id === current.id)) hideViewer();
  }

  function hideViewer() {
    viewer.hidden = true;
    current = null;
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
    $('viewerImage').removeAttribute('src');
  }

  async function show(record) {
    enhancing?.abort();
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    current = record;
    viewerUrl = URL.createObjectURL(record.blob);
    $('viewerImage').src = viewerUrl;
    $('viewerImage').alt = `${record.title} · ${record.label}`;
    $('viewerTitle').textContent = `${record.title} · ${record.label}`;
    $('viewerMeta').textContent = `${describePhoto(record)} · ${megabytes(record.blob?.size || record.bytes || 0)} · ${stamp(record.createdAt)}`;
    $('viewerDownload').href = viewerUrl;
    $('viewerDownload').download = fileName(record);
    frame.classList.add('fit');
    $('viewerZoom').textContent = '100%';
    $('enhanceStatus').textContent = '';
    delete $('enhanceStatus').dataset.tone;
    for (const button of document.querySelectorAll('.enhance-button')) {
      const scale = Number(button.dataset.scale);
      const fits = record.width * (record.imageHeight || record.height) * scale * scale <= 12_000_000;
      button.hidden = record.kind === 'ai';
      button.disabled = !fits;
      button.title = fits
        ? 'ШІ домальовує правдоподібні деталі; це не нові дані зйомки'
        : `Фото завелике для ×${scale}: наблизьте карту сильніше й зробіть нове фото`;
    }
    viewer.hidden = false;
    for (const card of list.children) card.setAttribute('aria-current', 'false');
    await render();
    viewer.scrollIntoView({ block: 'nearest' });
  }

  async function open(record) {
    if (!dialog.open) dialog.showModal();
    if (record) await show(record); else await render();
  }

  async function capture() {
    if (capturing) { capturing.abort(); return; }
    const targets = getTargets();
    if (!targets.length) { showStatus('Зачекайте, доки знімок завантажиться на карті.', 'error'); return; }
    capturing = new AbortController();
    photoButton.setAttribute('aria-busy', 'true');
    photoButton.textContent = 'Скасувати';
    const saved = [];
    try {
      for (const target of targets) {
        const prefix = targets.length > 1 ? `${target.sideName}: ` : '';
        showStatus(`${prefix}шукаємо найдетальніший рівень…`, 'info', 0);
        const photo = await capturePhoto(target, {
          signal: capturing.signal,
          onProgress: (done, total) => showStatus(`${prefix}збираємо фото… ${done} / ${total} тайлів`, 'info', 0)
        });
        const record = {
          id: `${Date.now()}-${target.side}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: Date.now(), kind: 'tiles',
          title: target.title, label: target.label, provider: target.source, layerId: target.layerId, credits: target.credits,
          center: { lat: target.center.lat, lng: target.center.lng }, zoom: target.zoom, magnification: target.magnification,
          captureZoom: photo.captureZoom, gain: photo.gain, metersPerPixel: photo.metersPerPixel, tiles: photo.tiles,
          width: photo.width, height: photo.height, imageHeight: photo.imageHeight, blob: photo.blob, thumb: photo.thumb
        };
        await store.save(record).catch(() => { throw new Error('Фото створено, але браузер не дозволив його зберегти. Звільніть місце або вимкніть приватний режим.'); });
        saved.push(record);
      }
      const first = saved[0];
      showStatus(`Фото збережено: ${first.width}×${first.height}, рівень ${first.captureZoom}${first.gain > 1 ? ` — у ${first.gain} раз${first.gain < 5 ? 'и' : 'ів'} детальніше, ніж на екрані` : ''}.`, 'info', 7000);
      await open(first);
    } catch (error) {
      if (capturing.signal.aborted) showStatus('Фото скасовано.', 'info', 3000);
      else showStatus(error.message || 'Не вдалося зробити фото.', 'error', 9000);
      await refreshCount();
    } finally {
      capturing = null;
      photoButton.removeAttribute('aria-busy');
      photoButton.innerHTML = photoLabel;
    }
  }

  async function enhance(button) {
    if (enhancing) { enhancing.abort(); return; }
    const record = current, scale = Number(button.dataset.scale);
    if (!record) return;
    const status = $('enhanceStatus');
    const controller = enhancing = new AbortController();
    const label = button.textContent;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Скасувати';
    for (const other of document.querySelectorAll('.enhance-button')) if (other !== button) other.disabled = true;
    status.dataset.tone = 'pending';
    status.textContent = 'Завантажуємо модель ШІ (~4 МБ, один раз)…';
    try {
      const { enhancePhoto } = await import('./enhance.js');
      const started = performance.now();
      const blob = await enhancePhoto(record.blob, {
        scale, imageHeight: record.imageHeight, credits: `${record.credits} · ШІ ×${scale}`, signal: controller.signal,
        onProgress: (rate, text) => { status.textContent = `${text} — не закривайте вікно`; }
      });
      const bitmap = await createImageBitmap(blob);
      const thumb = await thumbnail(bitmap);
      const entry = {
        ...record, id: `${Date.now()}-ai${scale}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(),
        kind: 'ai', scale, parentId: record.id, bytes: blob.size, label: `${record.label} · ШІ ×${scale}`,
        width: bitmap.width, height: bitmap.height, imageHeight: Math.round((record.imageHeight || record.height) * scale), blob, thumb
      };
      bitmap.close?.();
      await store.save(entry);
      enhancing = null;
      await show(entry);
      status.dataset.tone = 'success';
      status.textContent = `Готово за ${Math.round((performance.now() - started) / 1000)} с. Це ШІ-реконструкція: дрібні деталі можуть бути вигадані.`;
    } catch (error) {
      status.dataset.tone = controller.signal.aborted ? 'pending' : 'error';
      status.textContent = controller.signal.aborted ? 'ШІ-обробку скасовано.' : (error.message || 'ШІ-обробка не вдалася.');
    } finally {
      if (enhancing === controller) enhancing = null;
      button.removeAttribute('aria-busy');
      button.textContent = label;
      if (current === record) for (const other of document.querySelectorAll('.enhance-button')) {
        other.disabled = record.width * (record.imageHeight || record.height) * Number(other.dataset.scale) ** 2 > 12_000_000;
      }
    }
  }

  photoButton.addEventListener('click', capture);
  $('historyButton').addEventListener('click', () => open());
  $('closePhotos').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { enhancing?.abort(); hideViewer(); for (const url of thumbUrls.splice(0)) URL.revokeObjectURL(url); });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  const toggleZoom = () => {
    const fit = frame.classList.toggle('fit');
    $('viewerZoom').textContent = fit ? '100%' : 'Вмістити';
  };
  frame.addEventListener('click', toggleZoom);
  frame.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleZoom(); } });
  $('viewerZoom').addEventListener('click', toggleZoom);
  $('viewerMap').addEventListener('click', () => { if (current) { onShowOnMap(current); dialog.close(); } });
  $('viewerDelete').addEventListener('click', async () => {
    if (!current) return;
    await store.remove(current.id);
    hideViewer();
    await render();
  });
  $('clearPhotos').addEventListener('click', async () => {
    const count = (await store.list()).length;
    if (!count || !confirm(`Видалити всі фото з історії (${count})? Їх не можна буде відновити.`)) return;
    await store.clear();
    hideViewer();
    await render();
  });
  for (const button of document.querySelectorAll('.enhance-button')) button.addEventListener('click', () => enhance(button));
  refreshCount();
  return { open, capture };
}
