const TEAM_ID = 166;
const SEASON = 2025;
const SITE_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const CORE_API_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

const statusBanner = document.getElementById('status');
const statusText = statusBanner.querySelector('.status-text');
const offenseContainer = document.getElementById('offense-spotlight');
const defenseContainer = document.getElementById('defense-spotlight');
const cardTemplate = document.getElementById('player-card-template');
const gameBanner = document.getElementById('game-banner');

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

document.addEventListener('DOMContentLoaded', () => {
  loadSpotlight().catch((error) => reportError(error));
});

async function loadSpotlight() {
  statusText.textContent = 'Loading live data from ESPN…';
  showStatus(true);

  const latestEvent = await getLatestFinalEvent();
  if (!latestEvent) {
    gameBanner.innerHTML = `<p class="empty">No completed games have been recorded for the 2025 season yet. Check back soon.</p>`;
    statusText.textContent = 'No completed games available yet.';
    return;
  }

  const summary = await fetchJson(`${SITE_API_BASE}/summary?event=${latestEvent.id}`);
  const teamBoxscore = summary.boxscore?.players?.find((group) => group.team?.id === String(TEAM_ID));

  if (!teamBoxscore) {
    throw new Error('Unable to locate Aggies box score data for the latest game.');
  }

  renderGameBanner(latestEvent, summary);

  const offenseLeaders = await buildOffenseLeaders(teamBoxscore.statistics || []);
  const defenseLeaders = await buildDefenseLeaders(teamBoxscore.statistics || []);

  renderSpotlight(offenseContainer, offenseLeaders);
  renderSpotlight(defenseContainer, defenseLeaders);

  statusText.textContent = 'Spotlight updated with the latest 2025 data.';
  setTimeout(() => showStatus(false), 800);
}

async function getLatestFinalEvent() {
  const schedule = await fetchJson(`${SITE_API_BASE}/teams/${TEAM_ID}/schedule?season=${SEASON}`);
  const finalEvents = (schedule.events || []).filter((event) => {
    const competition = event.competitions?.[0];
    return competition?.status?.type?.name === 'STATUS_FINAL';
  });

  if (!finalEvents.length) {
    return null;
  }

  finalEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
  return finalEvents[finalEvents.length - 1];
}

async function buildOffenseLeaders(statistics) {
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

  return buildLeadersFromConfigs(statistics, configs);
}

async function buildDefenseLeaders(statistics) {
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

  return buildLeadersFromConfigs(statistics, configs);
}

async function buildLeadersFromConfigs(statistics, configs) {
  const selected = [];
  const usedIds = new Set();

  for (const config of configs) {
    const block = statistics.find((entry) => entry.name === config.category);
    if (!block) continue;

    const leader = extractLeader(block, config.columnIndex, usedIds);
    if (!leader) continue;

    const playerPackage = await fetchAthletePackage(leader.athlete.id);
    const seasonMetric = resolveStat(playerPackage.stats, config.seasonStat.category, config.seasonStat.stat);
    const seasonDetails = collectSeasonDetails(playerPackage.stats, SEASON_DETAIL_FIELDS[config.key] || []);

    let seasonValue = seasonMetric?.value ?? 0;
    let seasonDisplay = seasonMetric?.displayValue || seasonMetric?.display || '';

    if (!seasonDisplay && seasonDetails.length) {
      seasonDisplay = seasonDetails[0].display;
      seasonValue = parseStatValue(seasonDisplay);
    }

    const grade = computeGrade(config.key, leader.value, seasonValue);

    selected.push({
      id: leader.athlete.id,
      name: leader.athlete.displayName,
      headshot: leader.athlete.headshot?.href,
      role: config.label,
      lastMetricLabel: block.labels?.[config.columnIndex] || 'Stat',
      lastMetricDisplay: leader.display,
      seasonMetricLabel: config.seasonStat.label,
      seasonMetricDisplay: seasonDisplay || String(seasonValue),
      lastGameDetails: buildDetailsList(block, leader.stats),
      seasonDetails,
      grade,
      link: (leader.athlete.links || []).find((link) => link.rel?.includes('athlete'))?.href || `https://www.espn.com/college-football/player/_/id/${leader.athlete.id}`,
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

async function fetchAthletePackage(athleteId) {
  if (athleteCache.has(athleteId)) {
    return athleteCache.get(athleteId);
  }

  const profileUrl = `${CORE_API_BASE}/seasons/${SEASON}/athletes/${athleteId}?lang=en&region=us`;
  const profile = await fetchJson(profileUrl);
  let stats = null;

  if (profile.statistics?.$ref) {
    const statsUrl = profile.statistics.$ref.replace('http://', 'https://');
    stats = await fetchJson(statsUrl);
  }

  const result = { profile, stats };
  athleteCache.set(athleteId, result);
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
  container.replaceChildren();
  if (!players.length) {
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = 'No qualifying leaders available.';
    container.append(message);
    return;
  }

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

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

function showStatus(visible) {
  statusBanner.classList.toggle('hidden', !visible);
}

function reportError(error) {
  console.error(error);
  statusText.textContent = 'Unable to load spotlight data. Please try again later.';
  showStatus(true);
  offenseContainer.innerHTML = '<p class="empty">Data unavailable.</p>';
  defenseContainer.innerHTML = '<p class="empty">Data unavailable.</p>';
}
