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
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Отдаём дашборд как статический файл: /dashboard.html
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Входящий вебхук Битрикс24, например:
// https://yourportal.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
const B24_WEBHOOK_URL = process.env.B24_WEBHOOK_URL;

// Секрет для проверки исходящего вебхука Битрикс24 (application_token из настроек вебхука)
const B24_APP_TOKEN = process.env.B24_APP_TOKEN || '';

// Пароль для доступа к CEO-разделу (стоимость лида/квала/встречи по источникам).
// Задаётся через переменную окружения, чтобы не хранить его в коде на GitHub.
const CEO_DASHBOARD_PASSWORD = process.env.CEO_DASHBOARD_PASSWORD || '2283';

// Пароль для доступа к основному дашборду ключевых метрик.
const MAIN_DASHBOARD_PASSWORD = process.env.MAIN_DASHBOARD_PASSWORD || 'lEaPM)Z?';

// STAGE_ID стадии "Спам" — сделки на этой стадии формально закрыты (SEMANTICS: F),
// но если среди дублей есть сделка именно на этой стадии, всё равно считаем
// текущую сделку дублем (ставим флаг), независимо от статуса остальных дублей.
const SPAM_STAGE_ID = process.env.SPAM_STAGE_ID || 'UC_H1A47U';

// STAGE_ID стадии "НБТ" (не берёт трубку) — сделки на этой стадии считаются
// "недозвоном" и исключаются из расчёта конверсии в "Квал из дозвона".
const NBT_STAGE_ID = process.env.NBT_STAGE_ID || 'UC_7JBKLS';

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

/** Получить лид по id (используется, когда у сделки нет привязанного контакта) */
async function getLead(leadId) {
  return callB24('crm.lead.get', { id: leadId });
}

/** Извлечь номера телефонов и email из контакта/лида (нормализованные + оригинальные) */
function extractContactKeys(contact) {
  const rawPhones = (contact.PHONE || [])
    .map((p) => (p.VALUE || '').trim())
    .filter(Boolean);
  const emails = (contact.EMAIL || [])
    .map((e) => (e.VALUE || '').trim().toLowerCase())
    .filter(Boolean);
  return { rawPhones, emails };
}

/**
 * Битрикс24 хранит телефон ровно в том виде, в котором он был введён
 * (с "+" или без, с "8" или "7" в начале), и crm.contact.list фильтрует
 * по ТОЧНОМУ совпадению строки — без какой-либо нормализации на своей стороне.
 * Поэтому для поиска дублей нужно перебрать несколько правдоподобных
 * вариантов написания одного и того же номера, а не только "нормализованный".
 */
function buildPhoneVariants(raw) {
  if (!raw) return [];
  const variants = new Set();
  variants.add(raw); // как есть, оригинал — важно проверить именно его первым

  const digits = raw.replace(/\D/g, '');
  if (!digits) return Array.from(variants);

  variants.add(digits); // только цифры, без "+"
  variants.add(`+${digits}`); // с "+"

  // Российские номера: 8XXXXXXXXXX <-> 7XXXXXXXXXX <-> +7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('8')) {
    const with7 = '7' + digits.slice(1);
    variants.add(with7);
    variants.add(`+${with7}`);
  }
  if (digits.length === 11 && digits.startsWith('7')) {
    const with8 = '8' + digits.slice(1);
    variants.add(with8);
    variants.add(`+${with8}`);
  }

  return Array.from(variants);
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
  const { rawPhones, emails } = extractContactKeys(contact);
  if (rawPhones.length === 0 && emails.length === 0) {
    return { duplicates: [], matchedBy: null };
  }

  const matchedContactIds = new Set();

  // Поиск контактов по телефону — Битрикс24 фильтрует по точному совпадению строки,
  // поэтому перебираем все правдоподобные варианты написания номера (с "+", без,
  // с "8" вместо "7" и т.д.), а не только один нормализованный вариант.
  const triedPhoneVariants = new Set();
  for (const rawPhone of rawPhones) {
    for (const variant of buildPhoneVariants(rawPhone)) {
      if (triedPhoneVariants.has(variant)) continue; // не дублируем одинаковые запросы
      triedPhoneVariants.add(variant);
      const contacts = await callB24List('crm.contact.list', {
        filter: { PHONE: variant },
        select: ['ID'],
      });
      contacts.forEach((c) => matchedContactIds.add(c.ID));
    }
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

  return { duplicates, matchedBy: { phones: rawPhones, emails } };
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

function buildDuplicateMessage(duplicates, hasOpenDuplicate, isOriginal, hasSpamDuplicate) {
  let header;
  if (hasSpamDuplicate) {
    header = `🚫 Среди дублей есть сделка на стадии «Спам» (${duplicates.length} связанных сделок):`;
  } else if (isOriginal) {
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

  // Битрикс24 возвращает CONTACT_ID как строку "0" (не null, не отсутствует),
  // если контакт не привязан к сделке — это truthy-значение в JS, поэтому
  // сравниваем численно, а не просто проверяем на "истинность".
  const hasContact = deal.CONTACT_ID && Number(deal.CONTACT_ID) > 0;
  const hasLead = deal.LEAD_ID && Number(deal.LEAD_ID) > 0;

  let clientSource; // объект с полями PHONE/EMAIL — контакт или лид

  if (hasContact) {
    clientSource = await getContact(deal.CONTACT_ID);
  } else if (hasLead) {
    // Контакт не привязан (например, при неполной конвертации лида) —
    // берём телефон/email напрямую из исходного лида. У лида те же поля
    // PHONE/EMAIL в том же формате, что и у контакта.
    console.log(
      `Сделка ${dealId}: нет привязанного контакта, беру данные клиента из лида ${deal.LEAD_ID}`
    );
    clientSource = await getLead(deal.LEAD_ID);
  } else {
    console.log(`Сделка ${dealId}: нет ни контакта, ни лида, проверка дублей пропущена`);
    return;
  }

  const { duplicates, matchedBy } = await findDuplicateDeals(dealId, clientSource);

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

  // Отдельная проверка: есть ли среди дублей сделка на стадии "Спам".
  // Формально эта стадия закрыта (SEMANTICS: F), но наличие такого дубля
  // всё равно считаем поводом пометить текущую сделку как дубль —
  // независимо от статуса остальных найденных сделок.
  const hasSpamDuplicate = duplicates.some((d) => d.STAGE_ID === SPAM_STAGE_ID);

  // "Оригинал" ищем только среди ОТКРЫТЫХ сделок — текущая новая сделка
  // всегда считается открытой (она только что создана), закрытые дубли
  // (успех/провал) в расчёт эталона не берём вообще.
  // Самая ранняя по ID среди открытых кандидатов — оригинал, флаг ей не ставим.
  const openCandidateIds = [Number(dealId), ...openDuplicates.map((d) => Number(d.ID))];
  const earliestOpenDealId = Math.min(...openCandidateIds);
  const currentIsEarliestOpen = Number(dealId) === earliestOpenDealId;

  const message = buildDuplicateMessage(duplicates, hasOpenDuplicate, currentIsEarliestOpen, hasSpamDuplicate);
  await addTimelineComment(dealId, message);

  if (hasSpamDuplicate) {
    await markDealAsDuplicate(dealId);
    console.log(
      `Сделка ${dealId}: поле UF_CRM_1783286815 установлено в 1 (среди дублей есть сделка на стадии "Спам")`
    );
  } else if (hasOpenDuplicate && !currentIsEarliestOpen) {
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

/**
 * Справочник пользователей портала (ID -> человекочитаемое имя).
 * Нужен для отображения ФИО ответственного вместо голого ASSIGNED_BY_ID.
 * Кэшируется на время работы процесса, обновляется раз в 10 минут.
 */
let userMapCache = null;
let userMapCacheAt = 0;
const USER_CACHE_TTL_MS = 10 * 60 * 1000;

async function getUserMap() {
  const now = Date.now();
  if (userMapCache && now - userMapCacheAt < USER_CACHE_TTL_MS) {
    return userMapCache;
  }
  const users = await callB24List('user.get', {});
  const map = new Map();
  (users || []).forEach((u) => {
    const fullName = [u.LAST_NAME, u.NAME].filter(Boolean).join(' ') || u.EMAIL || `Пользователь #${u.ID}`;
    map.set(String(u.ID), fullName);
  });
  userMapCache = map;
  userMapCacheAt = now;
  return map;
}

/**
 * Справочник источников сделок (SOURCE_ID -> человекочитаемое название).
 * Кэшируется на время работы процесса, обновляется раз в 10 минут.
 */
let sourceMapCache = null;
let sourceMapCacheAt = 0;
const SOURCE_CACHE_TTL_MS = 10 * 60 * 1000;

async function getSourceMap() {
  const now = Date.now();
  if (sourceMapCache && now - sourceMapCacheAt < SOURCE_CACHE_TTL_MS) {
    return sourceMapCache;
  }
  const statuses = await callB24('crm.status.list', {
    filter: { ENTITY_ID: 'SOURCE' },
  });
  const map = new Map();
  (statuses || []).forEach((s) => map.set(s.STATUS_ID, s.NAME));
  sourceMapCache = map;
  sourceMapCacheAt = now;
  return map;
}

/**
 * Справочник стадий сделок (STAGE_ID -> { name, sort, semantics }).
 * Нужен, чтобы отдавать дашборду человекочитаемые названия стадий
 * в правильном порядке воронки (SORT), а не только внутренние ID.
 */
let stageInfoCache = null;
let stageInfoCacheAt = 0;

async function getStageInfoMap() {
  const now = Date.now();
  if (stageInfoCache && now - stageInfoCacheAt < STAGE_CACHE_TTL_MS) {
    return stageInfoCache;
  }
  const statuses = await callB24('crm.status.list', {
    filter: { ENTITY_ID: 'DEAL_STAGE' },
  });
  const map = new Map();
  (statuses || []).forEach((s) => {
    map.set(s.STATUS_ID, {
      name: s.NAME,
      sort: Number(s.SORT) || 0,
      semantics: s.SEMANTICS,
    });
  });
  stageInfoCache = map;
  stageInfoCacheAt = now;
  return map;
}

/**
 * API дашборда: агрегированные метрики по воронке сделок за период.
 * Query-параметры:
 *   from — дата начала периода (YYYY-MM-DD), по умолчанию без ограничения снизу
 *   to   — дата конца периода (YYYY-MM-DD), по умолчанию без ограничения сверху
 */
app.get('/api/dashboard-data', async (req, res) => {
  try {
    // Доступ разрешён по паролю обычного дашборда ИЛИ по CEO-паролю —
    // CEO-страница переиспользует тот же эндпоинт данных, добавляя свой
    // собственный UI (фильтр по ответственному, переход к цене лида).
    // Пароль может прийти в любом из двух заголовков, в зависимости от того,
    // какая страница делает запрос.
    const providedPassword = req.get('X-Dashboard-Password') || req.get('X-Ceo-Password') || '';
    if (providedPassword !== MAIN_DASHBOARD_PASSWORD && providedPassword !== CEO_DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    const { from, to, source, assignedBy } = req.query;

    const filter = {};
    if (from) filter['>=DATE_CREATE'] = `${from}T00:00:00`;
    if (to) filter['<=DATE_CREATE'] = `${to}T23:59:59`;
    // source может содержать несколько ID через запятую — Битрикс24 REST API
    // принимает массив значений в фильтре для выбора "любое из перечисленных".
    if (source) {
      const sourceIds = source.split(',').map((s) => s.trim()).filter(Boolean);
      if (sourceIds.length === 1) {
        filter['SOURCE_ID'] = sourceIds[0];
      } else if (sourceIds.length > 1) {
        filter['SOURCE_ID'] = sourceIds;
      }
    }
    // assignedBy — фильтр по ответственному менеджеру (ASSIGNED_BY_ID), нужен
    // только на CEO-странице, но параметр общий для обеих страниц.
    if (assignedBy) {
      const managerIds = assignedBy.split(',').map((s) => s.trim()).filter(Boolean);
      if (managerIds.length === 1) {
        filter['ASSIGNED_BY_ID'] = managerIds[0];
      } else if (managerIds.length > 1) {
        filter['ASSIGNED_BY_ID'] = managerIds;
      }
    }

    // Тянем все сделки за период одним постраничным обходом.
    const deals = await callB24List('crm.deal.list', {
      filter,
      select: [
        'ID',
        'TITLE',
        'ASSIGNED_BY_ID',
        'STAGE_ID',
        'SOURCE_ID',
        'OPPORTUNITY',
        'DATE_CREATE',
        'CLOSED',
        'STAGE_SEMANTIC_ID',
        'UF_CRM_1784287318', // Квал: 1 = сделка была квалифицирована, 0/пусто = нет
        'UF_CRM_1783286815', // Дубль: 1 = сделка помечена как дубль
      ],
    });

    const [stageInfoMap, sourceMap, userMap] = await Promise.all([
      getStageInfoMap(),
      getSourceMap(),
      getUserMap(),
    ]);

    // Группировка по стадиям — количество сделок на каждой стадии.
    const byStage = new Map();
    for (const deal of deals) {
      const key = deal.STAGE_ID;
      if (!byStage.has(key)) byStage.set(key, 0);
      byStage.set(key, byStage.get(key) + 1);
    }

    const stages = Array.from(byStage.entries())
      .map(([stageId, count]) => {
        const info = stageInfoMap.get(stageId) || { name: stageId, sort: 9999, semantics: null };
        return {
          stageId,
          name: info.name,
          sort: info.sort,
          semantics: info.semantics,
          count,
        };
      })
      .sort((a, b) => a.sort - b.sort);

    // Группировка по источникам — количество лидов/сделок на источник.
    const bySource = new Map();
    for (const deal of deals) {
      const key = deal.SOURCE_ID || '';
      if (!bySource.has(key)) bySource.set(key, 0);
      bySource.set(key, bySource.get(key) + 1);
    }

    const sources = Array.from(bySource.entries())
      .map(([sourceId, count]) => ({
        sourceId,
        name: sourceMap.get(sourceId) || (sourceId ? sourceId : 'Не указан'),
        count,
      }))
      .sort((a, b) => b.count - a.count);

    // Полный справочник источников (для выпадающего списка на фронтенде) —
    // не зависит от текущего фильтра по source, иначе список сузился бы
    // до одного пункта после применения фильтра.
    const allSources = Array.from(sourceMap.entries()).map(([sourceId, name]) => ({
      sourceId,
      name,
    }));

    // Группировка по ответственным менеджерам — количество сделок на каждого.
    const byManager = new Map();
    for (const deal of deals) {
      const key = deal.ASSIGNED_BY_ID || '';
      if (!byManager.has(key)) byManager.set(key, 0);
      byManager.set(key, byManager.get(key) + 1);
    }

    const managers = Array.from(byManager.entries())
      .map(([managerId, count]) => ({
        managerId,
        name: userMap.get(managerId) || (managerId ? `Пользователь #${managerId}` : 'Не назначен'),
        count,
      }))
      .sort((a, b) => b.count - a.count);

    // Полный справочник пользователей (для выпадающего списка на CEO-странице) —
    // не зависит от текущего фильтра по assignedBy, по тому же принципу, что allSources.
    const allManagers = Array.from(userMap.entries()).map(([managerId, name]) => ({
      managerId,
      name,
    }));

    // Сумма по успешным сделкам (для справки, если понадобится).
    const totalWonAmount = deals
      .filter((d) => d.STAGE_SEMANTIC_ID === 'S')
      .reduce((sum, d) => sum + (parseFloat(d.OPPORTUNITY) || 0), 0);

    // Конверсия в "Квал" — считается по полю UF_CRM_1784287318 (1 = квалифицирована),
    // а не по текущей стадии сделки: сделка может быть уже дальше по воронке,
    // но признак "была квалифицирована" остаётся зафиксированным в этом поле.
    // Сделки, помеченные как дубль (UF_CRM_1783286815 = 1), полностью исключаются
    // из расчёта — и из числителя, и из знаменателя, — чтобы не искажать конверсию.
    // Также исключаются сделки на стадии "Спам" с ответственными ID 21 и 1 —
    // они не должны влиять на конверсию в "Квал" вовсе.
    const EXCLUDED_SPAM_MANAGER_IDS = ['21', '1'];
    const nonDuplicateDeals = deals
      .filter((d) => Number(d.UF_CRM_1783286815) !== 1)
      .filter((d) => !(d.STAGE_ID === SPAM_STAGE_ID && EXCLUDED_SPAM_MANAGER_IDS.includes(String(d.ASSIGNED_BY_ID))));
    const qualCount = nonDuplicateDeals.filter((d) => Number(d.UF_CRM_1784287318) === 1).length;
    const qualConversion = nonDuplicateDeals.length > 0 ? (qualCount / nonDuplicateDeals.length) * 100 : 0;

    // Конверсия в "Квал из дозвона" — тот же расчёт, но дополнительно исключаем
    // сделки на стадии "НБТ" (недозвон) из знаменателя: "дозвон" здесь означает
    // "любая сделка, кроме зависшей на НБТ", а не отдельное поле в CRM.
    const dozvonDeals = nonDuplicateDeals.filter((d) => d.STAGE_ID !== NBT_STAGE_ID);
    const qualFromDozvonCount = dozvonDeals.filter((d) => Number(d.UF_CRM_1784287318) === 1).length;
    const qualFromDozvonConversion =
      dozvonDeals.length > 0 ? (qualFromDozvonCount / dozvonDeals.length) * 100 : 0;

    res.json({
      period: { from: from || null, to: to || null, source: source || null, assignedBy: assignedBy || null },
      totalDeals: deals.length,
      stages,
      sources,
      allSources,
      managers,
      allManagers,
      totalWonAmount,
      qualCount,
      qualConversion,
      qualFromDozvonCount,
      qualFromDozvonConversion,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Ошибка получения данных для дашборда:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Фиксированная цена за лид (в рублях) для источников с известной стоимостью привлечения.
// Ключ — SOURCE_ID (STATUS_ID из справочника crm.status.list, ENTITY_ID=SOURCE).
const FIXED_LEAD_PRICE_BY_SOURCE = {
  '1': 22, // DMP
  '2': 27, // DMP РЕАЛ
};

/**
 * API для CEO-страницы: цена квалифицированного лида и цена встречи по источникам.
 * Логика: для источников с фиксированной ценой лида (DMP/DMP РЕАЛ) считаем
 *   стоимость привлечения = кол-во лидов × фикс. цена за лид,
 * для остальных источников бюджет вводится вручную на клиенте (как в основном
 * дашборде) — сервер лишь отдаёт кол-во лидов, квал и встреч по каждому источнику,
 * а расчёт цены за квал/встречу для источников без фикс. цены доделывает клиент.
 *
 * Дубли (UF_CRM_1783286815 = 1) исключаются из всех расчётов конверсии,
 * как и в основном дашборде.
 */
app.get('/api/ceo-dashboard-data', async (req, res) => {
  try {
    // Проверка пароля — передаётся через заголовок X-Ceo-Password.
    // Сравнение происходит только на сервере, поэтому просмотр исходного
    // кода страницы в браузере не даёт доступа к паролю.
    const providedPassword = req.get('X-Ceo-Password') || '';
    if (providedPassword !== CEO_DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    const { from, to } = req.query;

    const filter = {};
    if (from) filter['>=DATE_CREATE'] = `${from}T00:00:00`;
    if (to) filter['<=DATE_CREATE'] = `${to}T23:59:59`;

    const deals = await callB24List('crm.deal.list', {
      filter,
      select: [
        'ID',
        'SOURCE_ID',
        'DATE_CREATE',
        'UF_CRM_1784287318', // Квал
        'UF_CRM_1784287360', // Встреча
        'UF_CRM_1783286815', // Дубль
      ],
    });

    const sourceMap = await getSourceMap();

    // Дубли не исключаются из общего числа лидов — за них тоже было заплачено,
    // и для честной "прозрачной" цены лида их нужно учитывать. А вот квал и
    // встречи считаем только среди НЕ-дублей — дубль в принципе не может
    // быть отдельно квалифицирован или назначена встреча по нему.
    const nonDuplicateDeals = deals.filter((d) => Number(d.UF_CRM_1783286815) !== 1);

    // Группируем по источнику: кол-во лидов (все сделки), квал и встречи (не-дубли).
    const bySource = new Map();
    for (const deal of deals) {
      const key = deal.SOURCE_ID || '';
      if (!bySource.has(key)) {
        bySource.set(key, { leads: 0, qual: 0, meetings: 0 });
      }
      bySource.get(key).leads += 1;
    }
    for (const deal of nonDuplicateDeals) {
      const key = deal.SOURCE_ID || '';
      if (!bySource.has(key)) {
        bySource.set(key, { leads: 0, qual: 0, meetings: 0 });
      }
      const bucket = bySource.get(key);
      if (Number(deal.UF_CRM_1784287318) === 1) bucket.qual += 1;
      if (Number(deal.UF_CRM_1784287360) === 1) bucket.meetings += 1;
    }

    const sources = Array.from(bySource.entries())
      .map(([sourceId, bucket]) => {
        const fixedLeadPrice = FIXED_LEAD_PRICE_BY_SOURCE[sourceId] ?? null;
        return {
          sourceId,
          name: sourceMap.get(sourceId) || (sourceId ? sourceId : 'Не указан'),
          leads: bucket.leads,
          qual: bucket.qual,
          meetings: bucket.meetings,
          fixedLeadPrice, // null, если для этого источника нет фиксированной цены
        };
      })
      .sort((a, b) => b.leads - a.leads);

    res.json({
      period: { from: from || null, to: to || null },
      totalDeals: deals.length,
      totalNonDuplicateDeals: nonDuplicateDeals.length,
      sources,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Ошибка получения данных для CEO-дашборда:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Извлечь домен из поля COMMENTS сделки, где он записан в формате "Домен: значение". */
function extractDomainFromComments(comments) {
  if (!comments) return null;
  const match = comments.match(/Домен:\s*([^\n\r]+)/i);
  if (!match) return null;
  const value = match[1].trim();
  return value || null;
}

/**
 * API для CEO-страницы: конверсия по доменам (сегмент внутри COMMENTS сделки,
 * формат "Домен: значение"). Логика идентична /api/ceo-dashboard-data,
 * но группировка идёт по домену, а не по SOURCE_ID, и без привязки к фиксированным
 * ценам за лид (для доменов таких цен нет — только сырые числа лидов/квала/встреч).
 */
app.get('/api/ceo-domains-data', async (req, res) => {
  try {
    const providedPassword = req.get('X-Ceo-Password') || '';
    if (providedPassword !== CEO_DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    const { from, to } = req.query;

    const filter = {};
    if (from) filter['>=DATE_CREATE'] = `${from}T00:00:00`;
    if (to) filter['<=DATE_CREATE'] = `${to}T23:59:59`;

    const deals = await callB24List('crm.deal.list', {
      filter,
      select: [
        'ID',
        'COMMENTS',
        'DATE_CREATE',
        'UF_CRM_1784287318', // Квал
        'UF_CRM_1784287360', // Встреча
        'UF_CRM_1783286815', // Дубль
      ],
    });

    // Как и в основном CEO-отчёте: общее число лидов включает дубли (за них
    // тоже заплачено), а квал/встречи считаются только среди не-дублей.
    const nonDuplicateDeals = deals.filter((d) => Number(d.UF_CRM_1783286815) !== 1);

    const byDomain = new Map();
    for (const deal of deals) {
      const domain = extractDomainFromComments(deal.COMMENTS) || 'Не указан';
      if (!byDomain.has(domain)) byDomain.set(domain, { leads: 0, qual: 0, meetings: 0 });
      byDomain.get(domain).leads += 1;
    }
    for (const deal of nonDuplicateDeals) {
      const domain = extractDomainFromComments(deal.COMMENTS) || 'Не указан';
      if (!byDomain.has(domain)) byDomain.set(domain, { leads: 0, qual: 0, meetings: 0 });
      const bucket = byDomain.get(domain);
      if (Number(deal.UF_CRM_1784287318) === 1) bucket.qual += 1;
      if (Number(deal.UF_CRM_1784287360) === 1) bucket.meetings += 1;
    }

    const domains = Array.from(byDomain.entries())
      .map(([domain, bucket]) => ({
        domain,
        leads: bucket.leads,
        qual: bucket.qual,
        meetings: bucket.meetings,
        qualConversion: bucket.leads > 0 ? (bucket.qual / bucket.leads) * 100 : 0,
        meetingConversion: bucket.leads > 0 ? (bucket.meetings / bucket.leads) * 100 : 0,
      }))
      .sort((a, b) => b.leads - a.leads);

    res.json({
      period: { from: from || null, to: to || null },
      totalDeals: deals.length,
      domains,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Ошибка получения данных по доменам для CEO-страницы:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Проверка живости сервиса (для healthcheck платформы деплоя, ожидающей ответ на "/")
app.get('/', (req, res) => res.status(200).send('ok'));

// Проверка живости сервиса
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Сервис поиска дубликатов сделок запущен на порту ${PORT}`);
});
