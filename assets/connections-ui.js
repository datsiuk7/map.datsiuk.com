import { KEY_SOURCES, validateKey, redactSecrets } from './credentials.js';
import { checkConnection } from './connection-checks.js';

const NAMES = { maptiler: 'MapTiler', mapbox: 'Mapbox' };

export function setupConnections({ store, getView, onCheckResult = () => {}, onApplied = () => {} }) {
  const $ = id => document.getElementById(id);
  const dialog = $('connectionsDialog');
  const checks = new Map();
  const input = source => $(`${source}Key`);
  const checkButton = source => dialog.querySelector(`.check-key[data-source="${source}"]`);
  const setStatus = (source, message, tone = '') => {
    const element = $(`${source}KeyStatus`);
    element.textContent = message;
    element.dataset.tone = tone;
  };
  const stopChecks = () => { for (const controller of checks.values()) controller.abort(); checks.clear(); };
  const countKeys = () => {
    const count = KEY_SOURCES.filter(source => store.get(source)).length;
    $('connectionsButton').textContent = `API-ключі${count ? ` (${count})` : ''}`;
  };
  const fill = () => {
    for (const source of KEY_SOURCES) {
      input(source).value = store.get(source);
      input(source).type = 'password';
      const reveal = dialog.querySelector(`.reveal-key[data-source="${source}"]`);
      reveal.textContent = 'Показати'; reveal.setAttribute('aria-pressed', 'false');
      reveal.setAttribute('aria-label', `Показати ключ ${NAMES[source]}`);
      setStatus(source, store.get(source) ? 'Ключ додано · можна перевірити' : 'Ключ не додано');
      checkButton(source).disabled = !store.get(source);
    }
    $('rememberKeys').checked = store.remember;
    $('keysSaveStatus').textContent = '';
  };
  const open = source => {
    if (!dialog.open) { fill(); dialog.showModal(); }
    if (KEY_SOURCES.includes(source)) input(source).focus();
  };
  $('connectionsButton').addEventListener('click', () => open());
  $('closeConnections').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    stopChecks();
    for (const source of KEY_SOURCES) { input(source).value = ''; input(source).type = 'password'; }
  });
  for (const source of KEY_SOURCES) {
    input(source).addEventListener('input', () => {
      checks.get(source)?.abort(); checks.delete(source);
      checkButton(source).disabled = !input(source).value.trim();
      setStatus(source, input(source).value.trim() === store.get(source) ? (store.get(source) ? 'Ключ додано · можна перевірити' : 'Ключ не додано') : 'Зміни ще не застосовано');
      $('keysSaveStatus').textContent = '';
    });
    dialog.querySelector(`.reveal-key[data-source="${source}"]`).addEventListener('click', event => {
      const visible = input(source).type === 'password';
      input(source).type = visible ? 'text' : 'password';
      event.currentTarget.textContent = visible ? 'Сховати' : 'Показати';
      event.currentTarget.setAttribute('aria-pressed', String(visible));
      event.currentTarget.setAttribute('aria-label', `${visible ? 'Сховати' : 'Показати'} ключ ${NAMES[source]}`);
    });
    checkButton(source).addEventListener('click', async () => {
      checks.get(source)?.abort();
      const controller = new AbortController(); checks.set(source, controller);
      const key = input(source).value.trim();
      checkButton(source).disabled = true;
      setStatus(source, 'Перевіряємо підключення…', 'pending');
      try {
        const result = await checkConnection(source, key, { ...getView(), signal: controller.signal });
        if (checks.get(source) !== controller) return;
        setStatus(source, result.message, 'success');
        onCheckResult(source, true, result.message, key);
      } catch (error) {
        if (checks.get(source) !== controller || controller.signal.aborted) return;
        const message = redactSecrets(error.message, [key]);
        setStatus(source, message, 'error');
        onCheckResult(source, false, message, key);
      } finally {
        if (checks.get(source) === controller) {
          checks.delete(source);
          checkButton(source).disabled = !input(source).value.trim();
        }
      }
    });
  }
  $('connectionsForm').addEventListener('submit', event => {
    event.preventDefault();
    const values = {};
    for (const source of KEY_SOURCES) {
      try { values[source] = validateKey(source, input(source).value); }
      catch (error) { setStatus(source, error.message, 'error'); input(source).focus(); return; }
    }
    stopChecks();
    const result = store.setAll(values, { remember: $('rememberKeys').checked });
    const message = !result.cleared ? 'Ключі застосовано, але браузер не дозволив очистити попереднє сховище. Перевірте дозволи зберігання цього сайту.'
      : result.mode === 'memory' && KEY_SOURCES.some(source => values[source]) ? 'Ключі діють лише до перезавантаження: браузер заблокував зберігання.'
      : result.mode === 'local' ? 'Ключі застосовано й збережено на цьому пристрої.'
      : KEY_SOURCES.some(source => values[source]) ? 'Ключі застосовано до закриття вкладки.' : 'Усі ключі видалено.';
    dialog.close();
    onApplied(message);
  });
  $('forgetKeys').addEventListener('click', () => {
    stopChecks();
    const result = store.clear(); fill();
    $('keysSaveStatus').textContent = result.cleared ? 'Усі ключі видалено зі сховищ цього сайту.' : 'Браузер не дозволив очистити сховище. Видаліть дані цього сайту в налаштуваннях браузера.';
    $('keysSaveStatus').dataset.tone = result.cleared ? 'success' : 'error';
    onApplied(result.cleared ? 'Усі ключі видалено.' : 'Перевірте дозволи зберігання ключів у браузері.');
  });
  store.subscribe(countKeys);
  countKeys();
  return { open };
}
