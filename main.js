const TEAM_ID = 166;
const TARGET_SEASON = 2025;
const SCHEDULE_PAGE_URL = `https://www.espn.com/college-football/team/schedule/_/id/${TEAM_ID}`;
const STATS_PAGE_URL = `https://www.espn.com/college-football/team/stats/_/id/${TEAM_ID}`;
const ESPN_PAGE_PROXY_PATH = '/api/espn-page';
const ESPN_PROXY_FALLBACKS = ['/.netlify/functions/espn-page'];

const FETCH_TIMEOUT_MS = 8000;
const RETRY_BASE_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 30000;
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

const OFFENSE_TYPES = [
  { type: 'passingYards', heading: 'Passing Leader' },
  { type: 'rushingYards', heading: 'Rushing Leader' },
  { type: 'receivingYards', heading: 'Receiving Leader' }
];

const DEFENSE_TYPES = [
  { type: 'totalTackles', heading: 'Tackles Leader' },
  { type: 'interceptions', heading: 'Interceptions Leader' }
];

const statusBanner = document.getElementById('status');
const statusText = statusBanner ? statusBanner.querySelector('.status-text') : null;
const seasonSubtitle = document.getElementById('season-subtitle');
const seasonNote = document.getElementById('season-note');
const offenseContainer = document.getElementById('offense-spotlight');
const defenseContainer = document.getElementById('defense-spotlight');
const cardTemplate = document.getElementById('player-card-template');
const gameBanner = document.getElementById('game-banner');
const offenseSubtitle = document.getElementById('offense-subtitle');
const defenseSubtitle = document.getElementById('defense-subtitle');
const debugToggle = document.getElementById('debug-toggle');
const debugPanel = document.getElementById('debug-panel');
const debugLogList = document.getElementById('debug-log');
const debugCount = document.getElementById('debug-count');
const debugClearButton = document.getElementById('debug-clear');
const debugCloseButton = document.getElementById('debug-close');
const debugLast = document.getElementById('debug-last');

const debugEntries = [];
let debugEntryId = 0;
let debugOpen = false;
let lastRequestSummary = null;
let activeSeason = TARGET_SEASON;

const formatterOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const dateFormatter = new Intl.DateTimeFormat('en-US', formatterOptions);

const RECENT_UPDATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

document.addEventListener('DOMContentLoaded', () => {
  setupDebugConsole();
  logDebug('info', 'Debug console initialised.');
  setContainerMessage(offenseContainer, 'Connecting to ESPN…');
  setContainerMessage(defenseContainer, 'Connecting to ESPN…');
  setGameBannerMessage('Waiting for ESPN schedule…');
  if (statusText) {
    statusText.textContent = 'Contacting ESPN web pages…';
  }
  showStatus(true);
  startPersistentLoad().catch((error) => reportError(error));
});

async function startPersistentLoad() {
  logDebug('info', 'Starting persistent ESPN load.', { teamId: TEAM_ID });
  let firstSuccessfulRender = true;

  while (true) {
    if (statusText) {
      statusText.textContent = firstSuccessfulRender
        ? 'Contacting ESPN web pages…'
        : 'Refreshing ESPN data…';
    }
    showStatus(true);

    try {
      const [scheduleData, statsData] = await Promise.all([
        fetchScheduleData(),
        fetchStatsData()
      ]);
      renderSpotlight(scheduleData, statsData);
      if (statusText) {
        statusText.textContent = `Updated from ESPN on ${RECENT_UPDATE_FORMATTER.format(new Date())}`;
      }
      setTimeout(() => showStatus(false), 1000);
      logDebug('info', firstSuccessfulRender ? 'Initial data load complete.' : 'ESPN refresh complete.');
      firstSuccessfulRender = false;
      await wait(REFRESH_INTERVAL_MS);
    } catch (error) {
      logDebug('error', 'Unexpected processing error while preparing ESPN data.', {
        message: error?.message
      });
      await wait(3000);
    }
  }
}

async function fetchScheduleData() {
  return fetchEspnPageJson(SCHEDULE_PAGE_URL, 'schedule page', (payload) => {
    const scheduleData = payload?.page?.content?.scheduleData;
    if (!scheduleData?.teamSchedule?.length) {
      throw new Error('Schedule payload did not include team schedule.');
    }

    const seasonBlock = scheduleData.teamSchedule[0];
    const postGames = Array.isArray(seasonBlock?.events?.post) ? seasonBlock.events.post : [];
    const preGames = Array.isArray(seasonBlock?.events?.pre) ? seasonBlock.events.pre : [];

    const lastFinal = postGames.length ? postGames[postGames.length - 1] : null;
    const nextGame = preGames.length ? preGames[0] : null;

    return {
      season: seasonBlock?.season ?? scheduleData.seasonTypeYear ?? TARGET_SEASON,
      record: scheduleData.team?.recordSummary ?? '',
      lastFinal,
      nextGame,
      raw: scheduleData
    };
  });
}

async function fetchStatsData() {
  return fetchEspnPageJson(STATS_PAGE_URL, 'stats page', (payload) => {
    const statsContent = payload?.page?.content?.stats;
    const teamLeaders = statsContent?.teamLeaders?.leaders;

    if (!Array.isArray(teamLeaders) || !teamLeaders.length) {
      throw new Error('Team leaders not available in stats payload.');
    }

    return {
      season: statsContent?.metadata?.season?.year ?? TARGET_SEASON,
      leaders: teamLeaders
    };
  });
}

async function fetchEspnPageJson(url, label, transform) {
  let attempt = 1;
  const proxyCandidates = buildProxyCandidateList();
  let proxyIndex = 0;

  while (true) {
    const start = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

    try {
      const proxyPath = proxyCandidates[proxyIndex];
      const proxyUrl = `${proxyPath}?url=${encodeURIComponent(url)}`;
      logDebug('info', `Fetching ${label}.`, { url, proxyUrl, attempt, proxyPath });
      const response = await fetch(proxyUrl, {
        signal: controller?.signal,
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const upstreamStatus = response.headers.get('x-espn-status');
        if (
          response.status === 404 &&
          !upstreamStatus &&
          proxyIndex < proxyCandidates.length - 1
        ) {
          const fallbackPath = proxyCandidates[proxyIndex + 1];
          logDebug('warn', 'Primary proxy returned 404, attempting fallback.', {
            label,
            proxyPath,
            fallbackPath
          });
          proxyIndex += 1;
          attempt = 1;
          await response.text().catch(() => '');
          continue;
        }

        const bodyText = await response.text().catch(() => '');
        const error = new Error(`Received ${response.status} from ESPN ${label}`);
        error.status = response.status;
        if (upstreamStatus) {
          error.upstreamStatus = Number(upstreamStatus);
        }
        if (bodyText) {
          error.responseBody = bodyText.slice(0, 2000);
        }
        throw error;
      }

      const cacheState = response.headers.get('x-proxy-cache') || 'unknown';
      const upstreamStatus = response.headers.get('x-espn-status');
      const payload = await response.json();
      const result = transform(payload);

      const end = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const durationMs = Math.round(end - start);

      updateDebugSummary({
        label,
        status: upstreamStatus || response.status,
        durationMs,
        cacheState,
        result: 'success',
        attempt
      });
      logDebug('info', `Fetched ${label}.`, {
        durationMs,
        attempt,
        cacheState,
        proxyPath,
        upstreamStatus: upstreamStatus ? Number(upstreamStatus) : undefined
      });

      return result;
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const end = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const durationMs = Math.round(end - start);
      const retryDelay = Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_DELAY_MS * attempt);

      const status = error?.name === 'AbortError' ? 'TIMEOUT' : error?.status || 'ERROR';
      updateDebugSummary({
        label,
        status,
        durationMs,
        result: 'retry',
        attempt,
        retryInMs: retryDelay,
        errorMessage: error?.message
      });

      logDebug('warn', `Attempt ${attempt} failed for ${label}.`, {
        status,
        durationMs,
        retryInMs: retryDelay,
        message: error?.message,
        proxyPath: proxyCandidates[proxyIndex],
        upstreamStatus: error?.upstreamStatus
      });

      await wait(retryDelay);
      attempt += 1;
    }
  }
}

function buildProxyCandidateList() {
  const candidates = [ESPN_PAGE_PROXY_PATH, ...ESPN_PROXY_FALLBACKS];
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate && !seen.has(candidate)) {
      unique.push(candidate);
      seen.add(candidate);
    }
  }
  return unique;
}

function renderSpotlight(scheduleData, statsData) {
  activeSeason = scheduleData?.season || statsData?.season || TARGET_SEASON;
  updateSeasonCopy(activeSeason);

  renderGameBanner(scheduleData);
  renderLeaders(offenseContainer, statsData, OFFENSE_TYPES, scheduleData?.record);
  renderLeaders(defenseContainer, statsData, DEFENSE_TYPES, scheduleData?.record);
}

function renderGameBanner(scheduleData) {
  if (!gameBanner) {
    return;
  }
  if (!scheduleData?.lastFinal && !scheduleData?.nextGame) {
    setGameBannerMessage('No recent or upcoming games available on ESPN. Retrying…');
    return;
  }

  const chunks = [];

  if (scheduleData.lastFinal) {
    const result = scheduleData.lastFinal.result;
    const opponent = scheduleData.lastFinal.opponent?.displayName ?? 'Opponent';
    const outcomeSymbol = result?.winLossSymbol === 'W' ? 'Win' : result?.winLossSymbol === 'L' ? 'Loss' : 'Result';
    const score = result?.currentTeamScore && result?.opponentTeamScore
      ? `${result.currentTeamScore}-${result.opponentTeamScore}`
      : '';
    const descriptor = `${outcomeSymbol}${score ? ` ${score}` : ''} vs ${opponent}`;
    chunks.push(descriptor);
  }

  const lastFinalDate = parseEspnDate(scheduleData.lastFinal?.date);
  if (lastFinalDate) {
    chunks.push(dateFormatter.format(lastFinalDate));
  }

  if (scheduleData.record) {
    chunks.push(`Record: ${scheduleData.record}`);
  }

  if (scheduleData.nextGame) {
    const opponent = scheduleData.nextGame.opponent?.displayName ?? 'TBD';
    chunks.push(`Next: ${opponent}`);
  }

  const content = chunks.filter(Boolean).join(' • ');
  gameBanner.replaceChildren();
  const paragraph = document.createElement('p');
  paragraph.textContent = content;
  gameBanner.append(paragraph);
}

function renderLeaders(container, statsData, desiredTypes, record) {
  if (!container) {
    return;
  }

  const leaders = desiredTypes
    .map((descriptor) => {
      const match = statsData?.leaders?.find((leader) => leader.type === descriptor.type);
      if (!match) {
        return null;
      }

      const primary = resolvePrimaryLeader(match, descriptor.heading);
      if (!primary) {
        return null;
      }

      return {
        heading: descriptor.heading,
        label: primary.label || descriptor.heading,
        value: primary.value || 'N/A',
        athlete: primary.athlete
      };
    })
    .filter(Boolean);

  if (!leaders.length) {
    setContainerMessage(container, 'Leaders unavailable on ESPN. Retrying…');
    return;
  }

  container.replaceChildren();
  leaders.forEach((leader) => {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    populateLeaderCard(card, leader, record);
    container.append(card);
  });
}

function populateLeaderCard(card, leader, record) {
  const headshot = card.querySelector('.card-headshot');
  headshot.src = normalizeAssetUrl(leader.athlete?.headshot) || 'https://a.espncdn.com/i/teamlogos/ncaa/500/166.png';
  headshot.alt = `${leader.athlete?.name || leader.heading} headshot`;

  const seasonHeading = card.querySelector('.card-season-heading');
  if (seasonHeading) {
    seasonHeading.textContent = `${activeSeason} Season Snapshot`;
  }

  card.querySelector('.card-role').textContent = leader.heading;
  card.querySelector('.card-name').textContent = leader.athlete?.name ?? 'Unknown Aggie';
  card.querySelector('.card-grade').textContent = leader.athlete?.position
    ? `Position: ${leader.athlete.position}`
    : 'Position unavailable';
  card.querySelector('.metric-last').textContent = `Season total: ${leader.value}`;
  card.querySelector('.metric-season').textContent = record ? `Team record: ${record}` : `Season: ${activeSeason}`;

  const lastList = card.querySelector('.card-last-list');
  lastList.replaceChildren(createDetailItem('Athlete', leader.athlete?.name ?? 'Unknown'));
  lastList.append(createDetailItem('Stat type', leader.label));

  const seasonList = card.querySelector('.card-season-list');
  seasonList.replaceChildren(createDetailItem('Season total', leader.value));
  seasonList.append(createDetailItem('Updated', RECENT_UPDATE_FORMATTER.format(new Date())));

  const link = card.querySelector('.card-link');
  link.href = leader.athlete?.href ? normalizeAssetUrl(leader.athlete.href) : STATS_PAGE_URL;
  link.textContent = `View ${leader.athlete?.name || 'Aggies'} on ESPN`;

  setupCardInteractions(card);
}

function resolvePrimaryLeader(match, fallbackLabel) {
  const sources = [];

  if (Array.isArray(match.leaders) && match.leaders.length) {
    sources.push(match.leaders[0]);
  }

  if (Array.isArray(match.leaderboard) && match.leaderboard.length) {
    sources.push(match.leaderboard[0]);
  }

  sources.push(match);

  for (const source of sources) {
    const normalized = normalizeLeaderSource(source, match, fallbackLabel);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeLeaderSource(source, container, fallbackLabel) {
  if (!source) {
    return null;
  }

  const athlete = normalizeLeaderAthlete(source.athlete);
  const label = firstNonEmpty([
    source.displayName,
    source.label,
    container?.displayName,
    container?.label,
    fallbackLabel
  ]);

  const rawValue = source.displayValue ?? source.value;
  const value = rawValue == null
    ? ''
    : typeof rawValue === 'number'
      ? rawValue.toLocaleString('en-US')
      : String(rawValue);

  if (!athlete && !value && !label) {
    return null;
  }

  return { athlete, label, value };
}

function normalizeLeaderAthlete(rawAthlete) {
  if (!rawAthlete) {
    return null;
  }

  const athlete = { ...rawAthlete };
  if (!athlete.name) {
    const normalizedName = firstNonEmpty([
      athlete.displayName,
      athlete.fullName,
      athlete.shortName,
      athlete.abbrev,
      athlete.initials
    ]);
    if (normalizedName) {
      athlete.name = normalizedName;
    }
  }

  return athlete;
}

function firstNonEmpty(values) {
  return values?.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function parseEspnDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? null : value;
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const direct = new Date(trimmed);
    if (!Number.isNaN(direct.valueOf())) {
      return direct;
    }

    if (/^\d+$/.test(trimmed)) {
      const timestamp = Number(trimmed);
      if (trimmed.length === 13) {
        const dateFromMs = new Date(timestamp);
        if (!Number.isNaN(dateFromMs.valueOf())) {
          return dateFromMs;
        }
      } else if (trimmed.length === 10) {
        const dateFromSeconds = new Date(timestamp * 1000);
        if (!Number.isNaN(dateFromSeconds.valueOf())) {
          return dateFromSeconds;
        }
      }
    }

    const numericIsoMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(?:Z)?$/);
    if (numericIsoMatch) {
      const [, year, month, day, hour, minute, second] = numericIsoMatch;
      const iso = `${year}-${month}-${day}T${hour}:${minute}:${second || '00'}Z`;
      const isoDate = new Date(iso);
      if (!Number.isNaN(isoDate.valueOf())) {
        return isoDate;
      }
    }

    const offsetMatch = trimmed.match(/^(.*)([+-]\d{4})$/);
    if (offsetMatch) {
      const [, base, offset] = offsetMatch;
      const iso = `${base}${offset.slice(0, 3)}:${offset.slice(3)}`;
      const offsetDate = new Date(iso);
      if (!Number.isNaN(offsetDate.valueOf())) {
        return offsetDate;
      }
    }
  }

  return null;
}

function createDetailItem(label, value) {
  const item = document.createElement('li');
  item.innerHTML = `<span>${label}</span><span>${value}</span>`;
  return item;
}

function normalizeAssetUrl(url) {
  if (!url) {
    return '';
  }
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  if (!/^https?:\/\//i.test(url)) {
    if (url.startsWith('/')) {
      return `https://www.espn.com${url}`;
    }
    return `https://www.espn.com/${url.replace(/^\/+/, '')}`;
  }
  return url.replace(/^http:\/\//i, 'https://');
}

function setupCardInteractions(card) {
  const toggle = card.querySelector('.card-toggle');
  const details = card.querySelector('.card-details');

  function setExpanded(expanded) {
    toggle.setAttribute('aria-expanded', String(expanded));
    details.hidden = !expanded;
    toggle.textContent = expanded ? 'Hide ESPN details' : 'Show ESPN details';
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    setExpanded(!expanded);
  });

  card.addEventListener('click', (event) => {
    if (event.target.closest('a') || event.target.closest('button')) {
      return;
    }
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    setExpanded(!expanded);
  });

  card.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === card) {
      event.preventDefault();
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      setExpanded(!expanded);
    }
  });
}

function updateSeasonCopy(season) {
  if (seasonSubtitle) {
    seasonSubtitle.textContent = `${season} Aggies Leaders`;
  }
  if (offenseSubtitle) {
    offenseSubtitle.textContent = `Season leaders pulled directly from ESPN (${season}).`;
  }
  if (defenseSubtitle) {
    defenseSubtitle.textContent = `Defensive impact players from ESPN (${season}).`;
  }
  if (seasonNote) {
    seasonNote.textContent = '';
    seasonNote.hidden = true;
    seasonNote.setAttribute('aria-hidden', 'true');
  }
}

function setupDebugConsole() {
  if (!debugToggle) {
    return;
  }

  debugToggle.addEventListener('click', () => {
    setDebugOpen(!debugOpen);
  });

  if (debugCloseButton) {
    debugCloseButton.addEventListener('click', () => setDebugOpen(false));
  }

  if (debugClearButton) {
    debugClearButton.addEventListener('click', () => {
      debugEntries.length = 0;
      updateDebugCount();
      renderDebugEntries();
      debugToggle.classList.remove('debug-toggle-error');
      logDebug('info', 'Debug log cleared.');
    });
  }

  updateDebugCount();
  updateDebugSummary(lastRequestSummary);
}

function setDebugOpen(open) {
  debugOpen = open;
  if (!debugToggle || !debugPanel) {
    return;
  }

  debugToggle.setAttribute('aria-expanded', String(open));
  debugPanel.hidden = !open;

  if (open) {
    renderDebugEntries();
  }
}

function renderDebugEntries() {
  if (!debugLogList) {
    return;
  }

  debugLogList.replaceChildren();

  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  for (const entry of debugEntries.slice().reverse()) {
    const item = document.createElement('li');
    item.dataset.level = entry.level;

    const time = document.createElement('time');
    time.dateTime = entry.timestamp.toISOString();
    time.textContent = formatter.format(entry.timestamp);
    item.append(time);

    const message = document.createElement('div');
    message.textContent = entry.message;
    item.append(message);

    if (entry.details) {
      const pre = document.createElement('pre');
      pre.textContent = typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details, null, 2);
      item.append(pre);
    }

    debugLogList.append(item);
  }
}

function updateDebugCount() {
  if (!debugCount) {
    return;
  }

  if (debugEntries.length) {
    debugCount.textContent = String(debugEntries.length);
    debugCount.hidden = false;
    debugCount.setAttribute('aria-hidden', 'false');
  } else {
    debugCount.textContent = '';
    debugCount.hidden = true;
    debugCount.setAttribute('aria-hidden', 'true');
  }
}

function logDebug(level, message, details) {
  debugEntryId += 1;
  debugEntries.push({
    id: debugEntryId,
    level,
    message,
    details,
    timestamp: new Date()
  });

  if (debugEntries.length > 250) {
    debugEntries.splice(0, debugEntries.length - 250);
  }

  if (level === 'error' && debugToggle) {
    debugToggle.classList.add('debug-toggle-error');
  }

  updateDebugCount();

  if (debugOpen) {
    renderDebugEntries();
  }
}

function updateDebugSummary(summary) {
  lastRequestSummary = summary;
  if (!debugLast) {
    return;
  }

  if (!summary) {
    debugLast.textContent = 'No ESPN requests yet.';
    return;
  }

  const parts = [];
  if (summary.status) {
    parts.push(String(summary.status).toUpperCase());
  }

  if (typeof summary.durationMs === 'number') {
    parts.push(`${summary.durationMs}ms`);
  }

  if (summary.retryInMs) {
    parts.push(`retrying in ${Math.round(summary.retryInMs / 100) / 10}s`);
  }

  if (summary.result === 'retry') {
    parts.push('retrying');
  } else if (summary.result === 'success') {
    parts.push('success');
  }

  if (summary.errorMessage) {
    parts.push(summary.errorMessage);
  }

  debugLast.textContent = `${summary.label}: ${parts.join(' • ')}`;
}

function showStatus(visible) {
  if (!statusBanner) return;
  statusBanner.classList.toggle('hidden', !visible);
}

function reportError(error) {
  console.error(error);
  logDebug('error', 'Spotlight error encountered.', {
    message: error?.message,
    stack: error?.stack
  });
  if (statusText) {
    statusText.textContent = 'Unable to load spotlight data. Retrying continuously…';
  }
  showStatus(true);
  setContainerMessage(offenseContainer, 'Data unavailable. Retrying…');
  setContainerMessage(defenseContainer, 'Data unavailable. Retrying…');
  setGameBannerMessage('Game details unavailable. Retrying…');
}

function setContainerMessage(container, message) {
  if (!container) return;
  container.replaceChildren();
  const paragraph = document.createElement('p');
  paragraph.className = 'empty';
  paragraph.textContent = message;
  container.append(paragraph);
}

function setGameBannerMessage(message) {
  if (!gameBanner) return;
  gameBanner.replaceChildren();
  const paragraph = document.createElement('p');
  paragraph.className = 'empty';
  paragraph.textContent = message;
  gameBanner.append(paragraph);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
