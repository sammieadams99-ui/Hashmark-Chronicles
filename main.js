const TEAM_ID = 166;
const TARGET_SEASON = 2025;
const FALLBACK_SEASONS = [TARGET_SEASON - 1];
const SITE_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const CORE_API_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

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

const PROXY_ENDPOINT = '/api/espn';
const FETCH_RETRY_LIMIT = 3;
const FETCH_TIMEOUT_MS = 8000;
const RETRY_BACKOFF_BASE_MS = 600;

const BENCHMARKS = {
  passing: { lastGameMax: 400, seasonMax: 3500 },
  rushing: { lastGameMax: 220, seasonMax: 1800 },
  receiving: { lastGameMax: 200, seasonMax: 1400 },
  tackles: { lastGameMax: 16, seasonMax: 130 },
  sacks: { lastGameMax: 4, seasonMax: 14 },
  passesDefended: { lastGameMax: 3, seasonMax: 20 }
};

const SEASON_DETAIL_FIELDS = {
  passing: [
    { category: 'passing', stat: 'completions', label: 'Completions' },
    { category: 'passing', stat: 'passingAttempts', label: 'Attempts' },
    { category: 'passing', stat: 'netPassingYards', label: 'Yards' },
    { category: 'passing', stat: 'passingTouchdowns', label: 'Pass TD' },
    { category: 'passing', stat: 'interceptions', label: 'INT' }
  ],
  rushing: [
    { category: 'rushing', stat: 'rushingAttempts', label: 'Carries' },
    { category: 'rushing', stat: 'rushingYards', label: 'Yards' },
    { category: 'rushing', stat: 'yardsPerRushAttempt', label: 'Yards/Carry' },
    { category: 'rushing', stat: 'rushingTouchdowns', label: 'Rush TD' }
  ],
  receiving: [
    { category: 'receiving', stat: 'receptions', label: 'Receptions' },
    { category: 'receiving', stat: 'receivingYards', label: 'Yards' },
    { category: 'receiving', stat: 'yardsPerReception', label: 'Yards/Catch' },
    { category: 'receiving', stat: 'receivingTouchdowns', label: 'Rec TD' }
  ],
  tackles: [
    { category: 'defensive', stat: 'totalTackles', label: 'Total Tackles' },
    { category: 'defensive', stat: 'soloTackles', label: 'Solo' },
    { category: 'defensive', stat: 'assistTackles', label: 'Assists' },
    { category: 'defensive', stat: 'sacks', label: 'Sacks' }
  ],
  sacks: [
    { category: 'defensive', stat: 'sacks', label: 'Sacks' },
    { category: 'defensive', stat: 'tacklesForLoss', label: 'TFL' },
    { category: 'defensive', stat: 'totalTackles', label: 'Total Tackles' },
    { category: 'defensive', stat: 'passesDefended', label: 'Pass Breakups' }
  ],
  passesDefended: [
    { category: 'defensive', stat: 'passesDefended', label: 'Pass Breakups' },
    { category: 'defensive', stat: 'interceptions', label: 'Interceptions' },
    { category: 'defensive', stat: 'totalTackles', label: 'Total Tackles' }
  ]
};

const athleteCache = new Map();
const debugEntries = [];
let debugOpen = false;
let debugEntryId = 0;
let activeSeason = TARGET_SEASON;
let fallbackSeason = null;
let lastRequestSummary = null;

document.addEventListener('DOMContentLoaded', () => {
  setupDebugConsole();
  logDebug('info', 'Debug console initialised.');
  setContainerMessage(offenseContainer, 'Loading leaders…');
  setContainerMessage(defenseContainer, 'Loading leaders…');
  setGameBannerMessage('Loading the latest final game…');
  loadSpotlight().catch((error) => reportError(error));
});

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

function updateSeasonCopy(season, isFallback, fallbackDetails) {
  if (seasonSubtitle) {
    seasonSubtitle.textContent = `${season} Offensive & Defensive Leaders`;
  }

  if (offenseSubtitle) {
    offenseSubtitle.textContent = `Top performers from the latest ${season} contest and their season pace.`;
  }

  if (defenseSubtitle) {
    defenseSubtitle.textContent = `Disruptors driving the Aggies' defense in ${season}.`;
  }

  if (seasonNote) {
    if (isFallback) {
      let note = `Showing ${season} results until ${TARGET_SEASON} data is published on ESPN.`;
      if (fallbackDetails?.outcome === 'error') {
        note += ` Last check for ${TARGET_SEASON}: ${fallbackDetails.message || 'request failed.'}`;
      } else if (fallbackDetails?.outcome === 'empty') {
        note += ` Last check found no completed games for ${TARGET_SEASON} yet.`;
      }
      seasonNote.textContent = note;
      seasonNote.hidden = false;
      seasonNote.setAttribute('aria-hidden', 'false');
    } else {
      seasonNote.textContent = '';
      seasonNote.hidden = true;
      seasonNote.setAttribute('aria-hidden', 'true');
    }
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
  if (summary.status !== undefined && summary.status !== null) {
    parts.push(String(summary.status).toUpperCase());
  }

  if (typeof summary.durationMs === 'number' && Number.isFinite(summary.durationMs)) {
    parts.push(`${Math.round(summary.durationMs)}ms`);
  }

  if (summary.cacheState) {
    parts.push(summary.cacheState.toLowerCase());
  }

  if (typeof summary.records === 'number' && Number.isFinite(summary.records)) {
    parts.push(`${summary.records} records`);
  }

  if (summary.attempts > 1 && summary.attempt > 1) {
    parts.push(`attempt ${summary.attempt}/${summary.attempts}`);
  }

  if (summary.result === 'error' && summary.errorMessage) {
    parts.push(summary.errorMessage);
  }

  const detailText = parts.length ? parts.join(' • ') : 'No details';
  debugLast.textContent = `${summary.label}: ${detailText}`;
}

async function loadSpotlight() {
  logDebug('info', 'Beginning spotlight refresh.', { teamId: TEAM_ID, targetSeason: TARGET_SEASON });
  if (statusText) {
    statusText.textContent = 'Loading live data from ESPN…';
  }
  updateSeasonCopy(TARGET_SEASON, false);
  showStatus(true);

  const seasonContext = await getLatestFinalEvent();
  if (!seasonContext) {
    logDebug('warn', 'No completed events available for attempted seasons.', {
      targetSeason: TARGET_SEASON,
      fallbacks: FALLBACK_SEASONS
    });
    fallbackSeason = null;
    activeSeason = TARGET_SEASON;
    updateSeasonCopy(activeSeason, false);
    setGameBannerMessage('ESPN has not posted any completed Aggies games yet. We will refresh automatically once results are available.');
    setContainerMessage(offenseContainer, 'No completed game data available yet.');
    setContainerMessage(defenseContainer, 'No completed game data available yet.');
    if (statusText) {
      statusText.textContent = 'Waiting for ESPN to publish game results.';
    }
    return;
  }

  activeSeason = seasonContext.season;
  fallbackSeason = seasonContext.fallbackFrom ? seasonContext.season : null;
  updateSeasonCopy(activeSeason, Boolean(fallbackSeason), seasonContext.fallbackReason);

  logDebug('info', 'Latest final event identified.', {
    eventId: seasonContext.event.id,
    opponent: seasonContext.event.name,
    date: seasonContext.event.date,
    season: activeSeason
  });

  const summary = await fetchJson(`${SITE_API_BASE}/summary?event=${seasonContext.event.id}`, `event ${seasonContext.event.id} summary`);
  const teamBoxscore = summary.boxscore?.players?.find((group) => group.team?.id === String(TEAM_ID));

  if (!teamBoxscore) {
    logDebug('error', 'Unable to find Aggies box score in summary payload.', { eventId: seasonContext.event.id });
    throw new Error('Unable to locate Aggies box score data for the latest game.');
  }

  renderGameBanner(seasonContext.event, summary);

  const offenseLeaders = await buildOffenseLeaders(teamBoxscore.statistics || [], activeSeason);
  const defenseLeaders = await buildDefenseLeaders(teamBoxscore.statistics || [], activeSeason);

  renderSpotlight(offenseContainer, offenseLeaders);
  renderSpotlight(defenseContainer, defenseLeaders);

  logDebug('info', 'Spotlight render complete.', {
    offenseCount: offenseLeaders.length,
    defenseCount: defenseLeaders.length,
    season: activeSeason
  });

  if (statusText) {
    statusText.textContent = fallbackSeason
      ? `Showing ${activeSeason} results until ${TARGET_SEASON} data is published on ESPN.`
      : `Spotlight updated with the latest ${activeSeason} data.`;
  }
  if (fallbackSeason) {
    showStatus(true);
  } else {
    setTimeout(() => showStatus(false), 800);
  }
}

async function getLatestFinalEvent() {
  const seasonsToTry = [TARGET_SEASON, ...FALLBACK_SEASONS.filter((season) => season > 0)];
  const attemptSummaries = [];

  for (const season of seasonsToTry) {
    try {
      const schedule = await fetchJson(`${SITE_API_BASE}/teams/${TEAM_ID}/schedule?season=${season}`, `team schedule ${season}`);
      const finalEvents = (schedule.events || []).filter((event) => {
        const competition = event.competitions?.[0];
        return competition?.status?.type?.name === 'STATUS_FINAL';
      });

      if (!finalEvents.length) {
        logDebug('warn', 'Schedule does not contain any final events.', { season });
        attemptSummaries.push({ season, outcome: 'empty', totalEvents: schedule.events?.length || 0 });
        continue;
      }

      finalEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
      logDebug('info', 'Resolved final events from schedule.', { count: finalEvents.length, season });

      if (season !== TARGET_SEASON) {
        const fallbackReason = attemptSummaries.find((entry) => entry.season === TARGET_SEASON) || null;
        logDebug('warn', 'Falling back to previous season schedule.', {
          targetSeason: TARGET_SEASON,
          fallbackSeason: season,
          reason: fallbackReason
        });
        return {
          season,
          event: finalEvents[finalEvents.length - 1],
          fallbackFrom: TARGET_SEASON,
          fallbackReason
        };
      }

      return {
        season,
        event: finalEvents[finalEvents.length - 1],
        fallbackFrom: null,
        fallbackReason: null
      };
    } catch (error) {
      logDebug('error', 'Network error while fetching team schedule.', {
        season,
        message: error?.message,
        status: error?.status
      });
      attemptSummaries.push({ season, outcome: 'error', message: error?.message, status: error?.status });
      continue;
    }
  }

  logDebug('error', 'Unable to resolve completed events after exhausting fallbacks.', {
    attempts: attemptSummaries
  });
  return null;
}

async function buildOffenseLeaders(statistics, season) {
  const configs = [
    {
      key: 'passing',
      label: 'Passing Leader',
      category: 'passing',
      columnIndex: 1,
      seasonStat: { category: 'passing', stat: 'netPassingYards', label: 'Passing Yards' }
    },
    {
      key: 'rushing',
      label: 'Rushing Leader',
      category: 'rushing',
      columnIndex: 1,
      seasonStat: { category: 'rushing', stat: 'rushingYards', label: 'Rushing Yards' }
    },
    {
      key: 'receiving',
      label: 'Receiving Leader',
      category: 'receiving',
      columnIndex: 1,
      seasonStat: { category: 'receiving', stat: 'receivingYards', label: 'Receiving Yards' }
    }
  ];

  return buildLeadersFromConfigs(statistics, configs, season);
}

async function buildDefenseLeaders(statistics, season) {
  const configs = [
    {
      key: 'tackles',
      label: 'Tackles Leader',
      category: 'defensive',
      columnIndex: 0,
      seasonStat: { category: 'defensive', stat: 'totalTackles', label: 'Total Tackles' }
    },
    {
      key: 'sacks',
      label: 'Sack Leader',
      category: 'defensive',
      columnIndex: 2,
      seasonStat: { category: 'defensive', stat: 'sacks', label: 'Sacks' }
    },
    {
      key: 'passesDefended',
      label: 'Pass Breakup Leader',
      category: 'defensive',
      columnIndex: 4,
      seasonStat: { category: 'defensive', stat: 'passesDefended', label: 'Passes Defended' }
    }
  ];

  return buildLeadersFromConfigs(statistics, configs, season);
}

async function buildLeadersFromConfigs(statistics, configs, season) {
  const selected = [];
  const usedIds = new Set();

  for (const config of configs) {
    const block = statistics.find((entry) => entry.name === config.category);
    if (!block) {
      logDebug('warn', `Statistic block missing in box score for ${config.label}.`, {
        category: config.category
      });
      continue;
    }

    const leader = extractLeader(block, config.columnIndex, usedIds);
    if (!leader) {
      logDebug('warn', `No qualifying leader found for ${config.label}.`, {
        category: config.category,
        columnIndex: config.columnIndex
      });
      continue;
    }

    const playerPackage = await fetchAthletePackage(leader.athlete.id, season);
    if (!playerPackage.stats) {
      logDebug('warn', `Season statistics payload missing for ${leader.athlete.displayName}.`, {
        athleteId: leader.athlete.id,
        role: config.label
      });
    }

    const headshotInfo = resolveHeadshot(leader.athlete, playerPackage.profile);
    if (!headshotInfo.url) {
      logDebug('warn', `No headshot available for ${leader.athlete.displayName}. Using fallback image.`, {
        athleteId: leader.athlete.id,
        sources: headshotInfo.sources
      });
    } else if (headshotInfo.source && headshotInfo.source !== 'boxscore headshot') {
      logDebug('info', `Headshot for ${leader.athlete.displayName} loaded from ${headshotInfo.source}.`, {
        athleteId: leader.athlete.id
      });
    }

    const seasonMetric = resolveStat(playerPackage.stats, config.seasonStat.category, config.seasonStat.stat);
    const seasonDetails = collectSeasonDetails(playerPackage.stats, SEASON_DETAIL_FIELDS[config.key] || []);

    let seasonValue = seasonMetric?.value ?? 0;
    let seasonDisplay = seasonMetric?.displayValue || seasonMetric?.display || '';

    if (!seasonDisplay && seasonDetails.length) {
      seasonDisplay = seasonDetails[0].display;
      seasonValue = parseStatValue(seasonDisplay);
    }

    if (!seasonDisplay) {
      logDebug('warn', `Season metric missing for ${leader.athlete.displayName}.`, {
        athleteId: leader.athlete.id,
        category: config.seasonStat.category,
        stat: config.seasonStat.stat
      });
    }

    if (!seasonDetails.length) {
      logDebug('warn', `Detailed season splits unavailable for ${leader.athlete.displayName}.`, {
        athleteId: leader.athlete.id,
        role: config.label
      });
    }

    const grade = computeGrade(config.key, leader.value, seasonValue);

    const profileLink = (leader.athlete.links || []).find((link) => link.rel?.includes('athlete'))?.href;
    const normalizedProfileLink = normalizeAssetUrl(profileLink);
    if (!normalizedProfileLink) {
      logDebug('warn', `Profile link missing for ${leader.athlete.displayName}. Using fallback URL.`, {
        athleteId: leader.athlete.id
      });
    }

    selected.push({
      id: leader.athlete.id,
      name: leader.athlete.displayName,
      headshot: headshotInfo.url,
      role: config.label,
      lastMetricLabel: block.labels?.[config.columnIndex] || 'Stat',
      lastMetricDisplay: leader.display,
      seasonMetricLabel: config.seasonStat.label,
      seasonMetricDisplay: seasonDisplay || String(seasonValue),
      lastGameDetails: buildDetailsList(block, leader.stats),
      seasonDetails,
      grade,
      link: normalizedProfileLink || `https://www.espn.com/college-football/player/_/id/${leader.athlete.id}`,
      lastValue: leader.value,
      seasonValue
    });

    logDebug('info', `${config.label} resolved.`, {
      athleteId: leader.athlete.id,
      name: leader.athlete.displayName,
      lastValue: leader.value,
      seasonValue
    });
  }

  return selected;
}

function extractLeader(block, columnIndex, usedIds) {
  const athletes = (block.athletes || [])
    .map((entry) => {
      const value = parseStatValue(entry.stats?.[columnIndex]);
      return {
        athlete: entry.athlete,
        stats: entry.stats || [],
        value,
        display: entry.stats?.[columnIndex] ?? '--'
      };
    })
    .filter((entry) => !Number.isNaN(entry.value));

  athletes.sort((a, b) => b.value - a.value);

  const leader = athletes.find((entry) => !usedIds.has(entry.athlete.id) && entry.value > 0) || athletes.find((entry) => !usedIds.has(entry.athlete.id));
  if (!leader) {
    return null;
  }

  usedIds.add(leader.athlete.id);
  return leader;
}

function buildDetailsList(block, stats) {
  if (!Array.isArray(block.labels) || !Array.isArray(stats)) {
    return [];
  }

  return block.labels
    .map((label, index) => ({ label, value: stats[index] }))
    .filter((item) => item.value !== undefined && item.value !== null && item.value !== '');
}

async function fetchAthletePackage(athleteId, season) {
  const resolvedSeason = season || activeSeason || TARGET_SEASON;
  const cacheKey = `${resolvedSeason}:${athleteId}`;

  if (athleteCache.has(cacheKey)) {
    logDebug('info', `Using cached athlete package.`, { athleteId, season: resolvedSeason });
    return athleteCache.get(cacheKey);
  }

  const profileUrl = `${CORE_API_BASE}/seasons/${resolvedSeason}/athletes/${athleteId}?lang=en&region=us`;
  logDebug('info', 'Fetching athlete profile.', { athleteId, season: resolvedSeason });
  const profile = await fetchJson(profileUrl, `athlete ${athleteId} profile (${resolvedSeason})`);
  let stats = null;

  if (profile.statistics?.$ref) {
    const statsUrl = profile.statistics.$ref.replace('http://', 'https://');
    logDebug('info', 'Fetching athlete statistics.', { athleteId, season: resolvedSeason });
    stats = await fetchJson(statsUrl, `athlete ${athleteId} statistics (${resolvedSeason})`);
  } else {
    logDebug('warn', 'Statistics reference missing from athlete profile.', { athleteId, season: resolvedSeason });
  }

  const result = { profile, stats };
  athleteCache.set(cacheKey, result);
  logDebug('info', 'Athlete package cached.', { athleteId, season: resolvedSeason });
  return result;
}

function resolveStat(statsData, categoryName, statName) {
  if (!statsData?.splits?.categories) {
    return null;
  }

  const category = statsData.splits.categories.find((entry) => entry.name === categoryName);
  if (!category) {
    return null;
  }

  const stat = category.stats?.find((entry) => entry.name === statName);
  if (!stat) {
    return null;
  }

  return {
    value: typeof stat.value === 'number' ? stat.value : Number(stat.value || 0),
    displayValue: stat.displayValue ?? String(stat.value ?? '0')
  };
}

function collectSeasonDetails(statsData, detailConfig) {
  if (!statsData?.splits?.categories) {
    return [];
  }

  return detailConfig
    .map((item) => {
      const stat = resolveStat(statsData, item.category, item.stat);
      if (!stat) return null;
      return {
        label: item.label,
        display: stat.displayValue ?? String(stat.value ?? '0')
      };
    })
    .filter(Boolean);
}

function resolveHeadshot(athlete, profile = {}) {
  const sources = [
    { value: athlete?.headshot?.href, label: 'boxscore headshot' },
    { value: profile?.headshot?.href, label: 'profile headshot' },
    { value: profile?.athlete?.headshot?.href, label: 'profile athlete headshot' },
    { value: profile?.team?.logos?.[0]?.href, label: 'team logo' }
  ];

  for (const source of sources) {
    const normalized = normalizeAssetUrl(source.value);
    if (normalized) {
      return {
        url: normalized,
        source: source.label,
        sources: sources.map((item) => item.value)
      };
    }
  }

  return {
    url: '',
    source: null,
    sources: sources.map((item) => item.value)
  };
}

function normalizeAssetUrl(url) {
  if (!url) {
    return '';
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  return url.replace(/^http:\/\//i, 'https://');
}

function computeGrade(key, lastValue, seasonValue) {
  const reference = BENCHMARKS[key] || { lastGameMax: 1, seasonMax: 1 };
  const gameRatio = Math.min(reference.lastGameMax ? lastValue / reference.lastGameMax : 0, 1);
  const seasonRatio = Math.min(reference.seasonMax ? seasonValue / reference.seasonMax : 0, 1);
  const score = Math.round(((gameRatio * 0.4) + (seasonRatio * 0.6)) * 100);
  const letter = determineLetter(score);
  return { score, letter };
}

function determineLetter(score) {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C-';
  if (score >= 67) return 'D+';
  if (score >= 63) return 'D';
  if (score >= 60) return 'D-';
  return 'F';
}

function renderSpotlight(container, players) {
  if (!players.length) {
    setContainerMessage(container, 'No qualifying leaders available.');
    return;
  }

  container.replaceChildren();

  for (const player of players) {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    populateCard(card, player);
    container.append(card);
  }
}

function populateCard(card, player) {
  const headshot = card.querySelector('.card-headshot');
  headshot.src = player.headshot || 'https://a.espncdn.com/i/teamlogos/ncaa/500/166.png';
  headshot.alt = `${player.name} headshot`;

  const seasonHeading = card.querySelector('.card-season-heading');
  if (seasonHeading) {
    seasonHeading.textContent = `${activeSeason} Season Snapshot`;
  }

  card.querySelector('.card-role').textContent = player.role;
  card.querySelector('.card-name').textContent = player.name;
  card.querySelector('.metric-last').textContent = `${player.lastMetricDisplay} ${player.lastMetricLabel || ''}`.trim();
  card.querySelector('.metric-season').textContent = `${player.seasonMetricDisplay} ${player.seasonMetricLabel}`;
  card.querySelector('.card-grade').textContent = `${player.grade.letter} · ${player.grade.score}%`;

  const lastList = card.querySelector('.card-last-list');
  player.lastGameDetails.forEach((detail) => {
    const item = document.createElement('li');
    item.innerHTML = `<span>${detail.label}</span><span>${detail.value}</span>`;
    lastList.append(item);
  });

  const seasonList = card.querySelector('.card-season-list');
  player.seasonDetails.forEach((detail) => {
    const item = document.createElement('li');
    item.innerHTML = `<span>${detail.label}</span><span>${detail.display}</span>`;
    seasonList.append(item);
  });

  const link = card.querySelector('.card-link');
  link.href = player.link;
  link.textContent = `View ${player.name} on ESPN`;

  setupCardInteractions(card);
}

function setupCardInteractions(card) {
  const toggle = card.querySelector('.card-toggle');
  const details = card.querySelector('.card-details');

  function setExpanded(expanded) {
    toggle.setAttribute('aria-expanded', String(expanded));
    details.hidden = !expanded;
    toggle.textContent = expanded ? 'Hide breakdown' : 'Show full breakdown';
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

function renderGameBanner(event, summary) {
  const competition = event.competitions?.[0];
  if (!competition) return;

  const teamSide = competition.competitors.find((competitor) => competitor.team?.id === String(TEAM_ID));
  const opponentSide = competition.competitors.find((competitor) => competitor.team?.id !== String(TEAM_ID));
  if (!teamSide || !opponentSide) return;

  const opponentName = opponentSide.team?.displayName ?? 'Opponent';
  const opponentRank = opponentSide.rank ? `No. ${opponentSide.rank} ` : '';
  const date = new Date(event.date);
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const outcome = teamSide.winner ? 'Win' : 'Loss';
  const resultLabel = `${outcome} ${teamSide.score}-${opponentSide.score} vs ${opponentRank}${opponentName}`;

  const venue = competition.venue?.fullName ? `${competition.venue.fullName} (${competition.venue.address?.city || ''})` : '';
  const attendance = summary.boxscore?.attendance ? `Attendance: ${summary.boxscore.attendance.toLocaleString()}` : '';

  const meta = [formatter.format(date), venue, attendance].filter(Boolean).join(' · ');

  gameBanner.innerHTML = `
    <h2>${resultLabel}</h2>
    <div class="game-meta">${meta}</div>
  `;
}

function parseStatValue(raw) {
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw !== 'string') {
    return 0;
  }
  if (raw === '--') {
    return 0;
  }
  const numeric = raw.replace(/[^0-9.\-]/g, '');
  return numeric ? Number(numeric) : 0;
}

function shouldRetryResponse(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error) {
  return (
    error?.name === 'AbortError' ||
    error?.name === 'TypeError' ||
    error?.message === 'Failed to fetch'
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHeaderNumber(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function fetchJson(url, label) {
  const context = label || url;
  const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const canMeasurePerformance = typeof performance !== 'undefined' && typeof performance.now === 'function';
  let lastError;

  for (let attempt = 1; attempt <= FETCH_RETRY_LIMIT; attempt += 1) {
    const attempts = FETCH_RETRY_LIMIT;
    const start = canMeasurePerformance ? performance.now() : Date.now();
    const requestUrl = new URL(PROXY_ENDPOINT, baseOrigin);
    requestUrl.searchParams.set('url', url);

    const finalUrl = requestUrl.toString();
    logDebug('info', `Fetching ${context}.`, { url: finalUrl, attempt });

    let controller;
    let timeoutId;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    }

    try {
      const response = await fetch(finalUrl, {
        headers: { Accept: 'application/json' },
        signal: controller?.signal
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const end = canMeasurePerformance ? performance.now() : Date.now();
      const duration = end - start;

      if (!response.ok) {
        const errorBody = await response.text();
        let parsedError;
        try {
          parsedError = errorBody ? JSON.parse(errorBody) : null;
        } catch (parseError) {
          parsedError = null;
        }

        const preview = typeof errorBody === 'string' ? errorBody.slice(0, 200) : '';
        logDebug('error', `Request failed (${response.status}) for ${context}.`, {
          url: finalUrl,
          status: response.status,
          attempt,
          durationMs: Math.round(duration),
          preview,
          details: parsedError?.error || parsedError?.message || parsedError?.details
        });

        const error = new Error(`Request failed (${response.status}) for ${context}`);
        error.status = response.status;
        error.preview = preview;
        error.details = parsedError ?? preview;
        lastError = error;

        if (shouldRetryResponse(response.status) && attempt < attempts) {
          const backoff = Math.pow(2, attempt - 1) * RETRY_BACKOFF_BASE_MS;
          logDebug('info', `Retrying ${context} after upstream error.`, {
            attempt: attempt + 1,
            backoffMs: backoff
          });
          await wait(backoff);
          continue;
        }

        updateDebugSummary({
          label: context,
          status: response.status,
          durationMs: Math.round(duration),
          cacheState: response.headers.get('x-espn-cache') || undefined,
          records: parseHeaderNumber(response.headers.get('x-espn-records')),
          result: 'error',
          attempt,
          attempts,
          errorMessage:
            parsedError?.error ||
            parsedError?.message ||
            parsedError?.details ||
            (preview ? `${preview}…` : 'Upstream error')
        });

        throw error;
      }

      const data = await response.json();
      const cacheState = response.headers.get('x-espn-cache') || 'MISS';
      const serverDuration = parseHeaderNumber(response.headers.get('x-espn-duration-ms'));
      const records = parseHeaderNumber(response.headers.get('x-espn-records'));
      const durationMs = Number.isFinite(serverDuration) ? serverDuration : Math.round(duration);

      logDebug('info', `Fetched ${context}.`, {
        url: finalUrl,
        status: response.status,
        durationMs,
        attempt,
        cache: cacheState,
        records
      });

      updateDebugSummary({
        label: context,
        status: response.status,
        durationMs,
        cacheState,
        records,
        result: 'success',
        attempt,
        attempts
      });

      return data;
    } catch (networkError) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const end = canMeasurePerformance ? performance.now() : Date.now();
      const duration = end - start;
      const isAbortError = networkError?.name === 'AbortError';

      logDebug('error', isAbortError ? `Request timed out for ${context}.` : `Network error while fetching ${context}.`, {
        url: finalUrl,
        attempt,
        durationMs: Math.round(duration),
        message: networkError?.message
      });

      lastError = networkError;

      if (attempt < attempts && isRetryableNetworkError(networkError)) {
        const backoff = Math.pow(2, attempt - 1) * RETRY_BACKOFF_BASE_MS;
        logDebug('info', `Retrying ${context} after delay.`, {
          attempt: attempt + 1,
          backoffMs: backoff
        });
        await wait(backoff);
        continue;
      }

      updateDebugSummary({
        label: context,
        status: isAbortError ? 'TIMEOUT' : networkError?.status || 'NETWORK',
        durationMs: Math.round(duration),
        cacheState: undefined,
        records: undefined,
        result: 'error',
        attempt,
        attempts,
        errorMessage: isAbortError ? 'Timed out' : networkError?.message || 'Network error'
      });

      throw networkError;
    }
  }

  updateDebugSummary({
    label: context,
    status: lastError?.status || 'ERROR',
    durationMs: undefined,
    cacheState: undefined,
    records: undefined,
    result: 'error',
    attempt: FETCH_RETRY_LIMIT,
    attempts: FETCH_RETRY_LIMIT,
    errorMessage: lastError?.message || `Unable to fetch ${context}`
  });

  throw lastError || new Error(`Unable to fetch ${context}`);
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
    statusText.textContent = 'Unable to load spotlight data. Please try again later.';
  }
  showStatus(true);
  setContainerMessage(offenseContainer, 'Data unavailable.');
  setContainerMessage(defenseContainer, 'Data unavailable.');
  setGameBannerMessage('Game details unavailable.');
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
  gameBanner.innerHTML = `<p class="empty">${message}</p>`;
}
