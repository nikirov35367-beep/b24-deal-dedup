/**
 * Bitrix24: поиск дубликатов сделки при создании (по телефону/email контакта)
 *
 * Как это работает:
 * 1. В портале Битрикс24 создаётся ВХОДЯЩИЙ вебхук (Settings -> Developer resources -> Inbound webhook)
 *    с правами: crm (сделки, контакты).
 * 2. В портале создаётся ИСХОДЯЩИЙ вебхук (Outbound webhook) на событие ONCRMDEALADD,
 *    указывающий на URL этого сервиса: https://<ваш-домен>/webhook/deal-add
 * 3. При создании новой сделки Битрикс24 присылает сюда deal_id.
 * 4. Сервис забирает сделку, находит связанный контакт, ищет по телефону/email
 *    другие сделки с тем же контактом, и если находит — добавляет комментарий
 *    (timeline comment) в новую сделку со списком дублей.
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Файл персистентной очереди отложенных запусков БП — переживает рестарт/деплой процесса.
// Хранится рядом со скриптом, а не в /tmp, чтобы не потерять при перезагрузке ОС.
const BIZPROC_QUEUE_FILE = path.join(__dirname, 'bizproc-queue.json');

// Входящий вебхук Битрикс24, например:
// https://yourportal.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
const B24_WEBHOOK_URL = process.env.B24_WEBHOOK_URL;

// Секрет для проверки исходящего вебхука Битрикс24 (application_token из настроек вебхука)
const B24_APP_TOKEN = process.env.B24_APP_TOKEN || '';

// Отдельный входящий вебхук с правами на запуск бизнес-процессов (bizproc.workflow.start)
const B24_BIZPROC_WEBHOOK_URL = process.env.B24_BIZPROC_WEBHOOK_URL;

// ID шаблона бизнес-процесса, который нужно запускать при создании каждой сделки
const DEAL_BIZPROC_TEMPLATE_ID = process.env.DEAL_BIZPROC_TEMPLATE_ID || '47';

// Задержка перед запуском бизнес-процесса (в миллисекундах)
const BIZPROC_START_DELAY_MS = 2 * 60 * 1000;

/**
 * Персистентная очередь отложенных запусков БП.
 * Формат файла: { "<dealId>": <timestamp запуска в ms>, ... }
 * При каждом старте сервиса очередь читается с диска: задачи, время которых
 * уже наступило (в том числе просроченные из-за рестарта/деплоя), запускаются
 * немедленно; остальные планируются через оставшееся время.
 */
function readBizprocQueue() {
  try {
    if (!fs.existsSync(BIZPROC_QUEUE_FILE)) return {};
    const raw = fs.readFileSync(BIZPROC_QUEUE_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Не удалось прочитать очередь БП, начинаем с пустой:', err.message);
    return {};
  }
}

function writeBizprocQueue(queue) {
  try {
    fs.writeFileSync(BIZPROC_QUEUE_FILE, JSON.stringify(queue), 'utf8');
  } catch (err) {
    console.error('Не удалось сохранить очередь БП на диск:', err.message);
  }
}

/** Добавить сделку в очередь на запуск БП через BIZPROC_START_DELAY_MS и запланировать в памяти */
function scheduleBizproc(dealId) {
  const runAt = Date.now() + BIZPROC_START_DELAY_MS;
  const queue = readBizprocQueue();
  queue[dealId] = runAt;
  writeBizprocQueue(queue);
  armBizprocTimer(dealId, runAt);
}

/** Убрать сделку из очереди после успешного (или окончательно неудачного) запуска БП */
function removeFromBizprocQueue(dealId) {
  const queue = readBizprocQueue();
  delete queue[dealId];
  writeBizprocQueue(queue);
}

/** Поставить in-memory таймер на конкретный момент времени (учитывая уже прошедшее время) */
function armBizprocTimer(dealId, runAt) {
  const delay = Math.max(0, runAt - Date.now());
  setTimeout(() => {
    startDealBizproc(dealId)
      .then(() => {
        console.log(`Сделка ${dealId}: запущен бизнес-процесс #${DEAL_BIZPROC_TEMPLATE_ID}`);
        removeFromBizprocQueue(dealId);
      })
      .catch((err) => {
        console.error(`Сделка ${dealId}: ошибка запуска бизнес-процесса:`, err.message);
        // Не убираем из очереди — при следующем рестарте сервиса попытка повторится.
      });
  }, delay);
}

/**
 * При старте сервиса подхватываем все задачи из персистентной очереди:
 * просроченные (runAt уже в прошлом) запускаются почти немедленно,
 * остальные — через оставшееся время. Так задержка переживает деплой/рестарт.
 */
function resumeBizprocQueueOnStartup() {
  const queue = readBizprocQueue();
  const dealIds = Object.keys(queue);
  if (dealIds.length === 0) return;

  console.log(`Восстановление очереди БП после рестарта: ${dealIds.length} отложенных задач`);
  dealIds.forEach((dealId) => {
    armBizprocTimer(dealId, queue[dealId]);
  });
}

if (!B24_WEBHOOK_URL) {
  console.error('ОШИБКА: не задана переменная окружения B24_WEBHOOK_URL');
  process.exit(1);
}

// Извлекаем домен портала (например https://b24-7ziwc7.bitrix24.ru) из URL входящего вебхука,
// чтобы формировать прямые ссылки на карточки сделок в комментариях.
const PORTAL_BASE_URL = (() => {
  try {
    const u = new URL(B24_WEBHOOK_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
})();

function dealUrl(dealId) {
  if (!PORTAL_BASE_URL) return null;
  return `${PORTAL_BASE_URL}/crm/deal/details/${dealId}/`;
}

// Кэш справочника стадий сделок (STATUS_ID -> SEMANTICS: 'P' в работе, 'S' успех, 'F' провал).
// Обновляется раз в 10 минут, чтобы не дёргать API на каждый запрос.
let stageSemanticsCache = null;
let stageSemanticsCacheAt = 0;
const STAGE_CACHE_TTL_MS = 10 * 60 * 1000;

async function getStageSemanticsMap() {
  const now = Date.now();
  if (stageSemanticsCache && now - stageSemanticsCacheAt < STAGE_CACHE_TTL_MS) {
    return stageSemanticsCache;
  }

  // crm.status.list возвращает все статусы всех справочников, включая стадии сделок
  // по всем воронкам (DEAL_STAGE и DEAL_STAGE_<CATEGORY_ID>).
  const statuses = await callB24('crm.status.list', {
    filter: { ENTITY_ID: 'DEAL_STAGE' },
  });

  const map = new Map();
  (statuses || []).forEach((s) => {
    map.set(s.STATUS_ID, s.SEMANTICS);
  });

  // Дополнительно подтягиваем стадии из остальных воронок (DEAL_STAGE_<ID>),
  // так как базовый DEAL_STAGE покрывает только воронку по умолчанию.
  try {
    const categories = await callB24('crm.dealcategory.list', {});
    for (const cat of categories || []) {
      if (String(cat.ID) === '0') continue; // основная воронка уже учтена выше
      const catStatuses = await callB24('crm.status.list', {
        filter: { ENTITY_ID: `DEAL_STAGE_${cat.ID}` },
      });
      (catStatuses || []).forEach((s) => {
        map.set(s.STATUS_ID, s.SEMANTICS);
      });
    }
  } catch (err) {
    console.warn('Не удалось получить стадии дополнительных воронок:', err.message);
  }

  stageSemanticsCache = map;
  stageSemanticsCacheAt = now;
  return map;
}

/** Считать сделку "в работе", если её стадия не имеет семантику успеха (S) или провала (F) */
async function isDealOpen(deal) {
  const map = await getStageSemanticsMap();
  const semantics = map.get(deal.STAGE_ID);
  // Если семантика неизвестна (не нашли в справочнике) — по умолчанию считаем сделку открытой,
  // чтобы не пропустить реальный дубль из-за отсутствия данных.
  if (!semantics) return true;
  return semantics === 'P';
}

function b24(method) {
  return `${B24_WEBHOOK_URL.replace(/\/$/, '')}/${method}`;
}

async function callB24(method, params = {}) {
  const { data } = await axios.post(b24(method), params, {
    timeout: 15000,
  });
  if (data.error) {
    throw new Error(`B24 API error [${method}]: ${data.error_description || data.error}`);
  }
  return data.result;
}

/**
 * Полный постраничный обход списочных методов (crm.contact.list, crm.deal.list и т.п.).
 * Битрикс24 REST API отдаёт максимум 50 записей за вызов; в ответе поле `next`
 * указывает смещение для следующей страницы, а `total` — общее число записей.
 * Без этого обхода при более чем 50 совпадениях часть данных (обычно самые новые
 * записи) просто не возвращается, и поиск дублей перестаёт находить их.
 */
async function callB24List(method, params = {}) {
  let start = 0;
  let allResults = [];

  while (true) {
    const { data } = await axios.post(
      b24(method),
      { ...params, start },
      { timeout: 15000 }
    );

    if (data.error) {
      throw new Error(`B24 API error [${method}]: ${data.error_description || data.error}`);
    }

    const page = data.result || [];
    allResults = allResults.concat(page);

    if (typeof data.next === 'number') {
      start = data.next;
    } else {
      break; // страниц больше нет
    }
  }

  return allResults;
}

/** Получить сделку по id */
async function getDeal(dealId) {
  return callB24('crm.deal.get', { id: dealId });
}

/** Получить контакт по id */
async function getContact(contactId) {
  return callB24('crm.contact.get', { id: contactId });
}

/** Запустить бизнес-процесс на сделке через отдельный вебхук bizproc.workflow.start */
async function startDealBizproc(dealId) {
  if (!B24_BIZPROC_WEBHOOK_URL) {
    console.warn(
      `Сделка ${dealId}: не задана переменная B24_BIZPROC_WEBHOOK_URL, запуск БП пропущен`
    );
    return;
  }

  const url = `${B24_BIZPROC_WEBHOOK_URL.replace(/\/$/, '')}/bizproc.workflow.start.json`;
  const { data } = await axios.post(
    url,
    {
      TEMPLATE_ID: DEAL_BIZPROC_TEMPLATE_ID,
      DOCUMENT_ID: ['crm', 'CCrmDocumentDeal', `DEAL_${dealId}`],
    },
    { timeout: 15000 }
  );

  if (data.error) {
    throw new Error(`bizproc.workflow.start error: ${data.error_description || data.error}`);
  }

  return data.result;
}

/** Извлечь номера телефонов и email из контакта (нормализованные) */
function extractContactKeys(contact) {
  const phones = (contact.PHONE || [])
    .map((p) => normalizePhone(p.VALUE))
    .filter(Boolean);
  const emails = (contact.EMAIL || [])
    .map((e) => (e.VALUE || '').trim().toLowerCase())
    .filter(Boolean);
  return { phones, emails };
}

function normalizePhone(raw) {
  if (!raw) return null;
  // оставляем только цифры, отбрасываем ведущие + и лишние символы
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // приводим российские номера 8XXXXXXXXXX -> 7XXXXXXXXXX для единообразия
  if (digits.length === 11 && digits.startsWith('8')) {
    return '7' + digits.slice(1);
  }
  return digits;
}

/**
 * Найти сделки-дубликаты: ищем все сделки, у которых контакт (CONTACT_ID)
 * совпадает с телефоном/email текущего контакта, исключая саму сделку.
 *
 * Стратегия:
 * 1. Найти все контакты, у которых есть совпадающий телефон или email (crm.contact.list с фильтром).
 * 2. Для каждого такого контакта получить список его сделок (crm.deal.list по CONTACT_ID).
 * 3. Исключить текущую сделку и вернуть остальные.
 */
async function findDuplicateDeals(currentDealId, contact) {
  const { phones, emails } = extractContactKeys(contact);
  if (phones.length === 0 && emails.length === 0) {
    return { duplicates: [], matchedBy: null };
  }

  const matchedContactIds = new Set();

  // Поиск контактов по телефону (полный постраничный обход — совпадений может быть > 50)
  for (const phone of phones) {
    const contacts = await callB24List('crm.contact.list', {
      filter: { PHONE: phone },
      select: ['ID'],
    });
    contacts.forEach((c) => matchedContactIds.add(c.ID));
  }

  // Поиск контактов по email (полный постраничный обход)
  for (const email of emails) {
    const contacts = await callB24List('crm.contact.list', {
      filter: { EMAIL: email },
      select: ['ID'],
    });
    contacts.forEach((c) => matchedContactIds.add(c.ID));
  }

  if (matchedContactIds.size === 0) {
    return { duplicates: [], matchedBy: null };
  }

  // Для каждого совпавшего контакта получаем его сделки (тоже с полным постраничным обходом)
  const allDeals = [];
  for (const contactId of matchedContactIds) {
    const deals = await callB24List('crm.deal.list', {
      filter: { CONTACT_ID: contactId },
      select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
    });
    allDeals.push(...deals);
  }

  // Убираем дубли и текущую сделку
  const seen = new Set();
  const duplicates = [];
  for (const deal of allDeals) {
    if (String(deal.ID) === String(currentDealId)) continue;
    if (seen.has(deal.ID)) continue;
    seen.add(deal.ID);
    duplicates.push(deal);
  }

  return { duplicates, matchedBy: { phones, emails } };
}

/** Добавить комментарий в таймлайн сделки */
async function addTimelineComment(dealId, text) {
  return callB24('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: text,
    },
  });
}

/** Проставить признак "дубль" (UF_CRM_1783286815 = 1) в сделке */
async function markDealAsDuplicate(dealId) {
  return callB24('crm.deal.update', {
    id: dealId,
    fields: {
      UF_CRM_1783286815: 1,
    },
  });
}

function buildDuplicateMessage(duplicates, hasOpenDuplicate, isOriginal) {
  let header;
  if (isOriginal) {
    // Текущая сделка — самая ранняя среди открытых дублей, то есть "оригинал".
    // Даже если у неё есть закрытые дубли или более поздние открытые (которые сами получат флаг),
    // с точки зрения этой сделки активных дублей, мешающих ей, нет.
    header = `✅ Дублей на активных стадиях нет (эта сделка — самая ранняя среди совпадений по контакту). Найдено связанных сделок: ${duplicates.length}:`;
  } else if (hasOpenDuplicate) {
    header = `⚠️ Обнаружены возможные дубликаты сделки (${duplicates.length}), есть открытые:`;
  } else {
    header = `ℹ️ Найдены сделки этого же контакта (${duplicates.length}), но все они уже закрыты (успех/провал) — информационно:`;
  }
  const lines = [header];
  duplicates.slice(0, 10).forEach((d) => {
    const url = dealUrl(d.ID);
    const dealLabel = url ? `[URL=${url}]Сделка #${d.ID} "${d.TITLE}"[/URL]` : `Сделка #${d.ID} "${d.TITLE}"`;
    lines.push(
      `— ${dealLabel} (стадия: ${d.STAGE_ID}, создана: ${d.DATE_CREATE})`
    );
  });
  if (duplicates.length > 10) {
    lines.push(`... и ещё ${duplicates.length - 10}`);
  }
  return lines.join('\n');
}

/** Проверка application_token исходящего вебхука Битрикс24, если задан */
function checkAppToken(req) {
  if (!B24_APP_TOKEN) return true; // проверка отключена, если токен не настроен
  const token = req.body.auth?.application_token || req.body.application_token;
  return token === B24_APP_TOKEN;
}

app.post('/webhook/deal-add', async (req, res) => {
  try {
    if (!checkAppToken(req)) {
      console.warn('Неверный application_token, запрос отклонён');
      return res.status(403).send('forbidden');
    }

    // Битрикс24 присылает событие в формате: data[FIELDS][ID]
    const dealId =
      req.body?.data?.FIELDS?.ID ||
      req.body?.data?.FIELDS?.ID?.[0] ||
      req.query.ID;

    if (!dealId) {
      console.warn('Не найден ID сделки в запросе', req.body);
      return res.status(400).send('no deal id');
    }

    // Отвечаем Битрикс24 сразу, обработку делаем асинхронно,
    // чтобы не блокировать вебхук (Б24 ждёт быстрый ответ).
    res.status(200).send('ok');

    processDeal(dealId).catch((err) => {
      console.error('Ошибка обработки сделки', dealId, err.message);
    });

    // Планируем запуск бизнес-процесса #47 через персистентную очередь —
    // задача сохраняется на диск и переживает рестарт/деплой процесса.
    // Запускается всегда, независимо от результата поиска дублей.
    scheduleBizproc(dealId);
  } catch (err) {
    console.error('Ошибка в обработчике webhook', err);
    if (!res.headersSent) res.status(500).send('error');
  }
});

async function processDeal(dealId) {
  const deal = await getDeal(dealId);
  if (!deal) {
    console.warn(`Сделка ${dealId} не найдена`);
    return;
  }

  if (!deal.CONTACT_ID) {
    console.log(`Сделка ${dealId}: нет привязанного контакта, проверка дублей пропущена`);
    return;
  }

  const contact = await getContact(deal.CONTACT_ID);
  const { duplicates, matchedBy } = await findDuplicateDeals(dealId, contact);

  if (duplicates.length === 0) {
    console.log(`Сделка ${dealId}: дубликатов не найдено`);
    return;
  }

  console.log(
    `Сделка ${dealId}: найдено ${duplicates.length} дубликатов (совпадение: ${JSON.stringify(matchedBy)})`
  );

  // Проверяем, какие из дублей открыты ("в работе")
  const openFlags = await Promise.all(duplicates.map((d) => isDealOpen(d)));
  const openDuplicates = duplicates.filter((_, i) => openFlags[i]);
  const hasOpenDuplicate = openDuplicates.length > 0;

  // "Оригинал" ищем только среди ОТКРЫТЫХ сделок — текущая новая сделка
  // всегда считается открытой (она только что создана), закрытые дубли
  // (успех/провал) в расчёт эталона не берём вообще.
  // Самая ранняя по ID среди открытых кандидатов — оригинал, флаг ей не ставим.
  const openCandidateIds = [Number(dealId), ...openDuplicates.map((d) => Number(d.ID))];
  const earliestOpenDealId = Math.min(...openCandidateIds);
  const currentIsEarliestOpen = Number(dealId) === earliestOpenDealId;

  const message = buildDuplicateMessage(duplicates, hasOpenDuplicate, currentIsEarliestOpen);
  await addTimelineComment(dealId, message);

  if (hasOpenDuplicate && !currentIsEarliestOpen) {
    await markDealAsDuplicate(dealId);
    console.log(
      `Сделка ${dealId}: поле UF_CRM_1783286815 установлено в 1 (есть открытый дубль, оригинал — сделка ${earliestOpenDealId})`
    );
  } else if (hasOpenDuplicate && currentIsEarliestOpen) {
    console.log(
      `Сделка ${dealId}: это самая ранняя открытая сделка среди дублей (оригинал), флаг не ставим`
    );
  } else {
    console.log(`Сделка ${dealId}: все дубли закрыты (успех/провал), флаг дубля не ставим`);
  }
}

// Проверка живости сервиса (для healthcheck платформы деплоя, ожидающей ответ на "/")
app.get('/', (req, res) => res.status(200).send('ok'));

// Проверка живости сервиса
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Сервис поиска дубликатов сделок запущен на порту ${PORT}`);
  resumeBizprocQueueOnStartup();
});
