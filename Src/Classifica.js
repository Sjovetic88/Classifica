// ==========================================
// FUNZIONI MATEMATICHE DIXON-COLES
// ==========================================
function factorial(n) {
  if (n <= 1) return 1;
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

function poissonPMF(k, lambda) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

function tau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function calculateMatchProbabilities(homeTeam, awayTeam, rho) {
  const hAdv = homeTeam.h_factor ? (1 + homeTeam.h_factor / 100) : 1.25;
  const lambda = Math.max(0.2, (homeTeam.attacco || 1.0) * (awayTeam.difesa || 1.0) * hAdv);
  const mu = Math.max(0.2, (awayTeam.attacco || 1.0) * (homeTeam.difesa || 1.0));

  let pHome = 0, pDraw = 0, pAway = 0;
  for (let x = 0; x <= 7; x++) {
    for (let y = 0; y <= 7; y++) {
      const p = poissonPMF(x, lambda) * poissonPMF(y, mu) * tau(x, y, lambda, mu, rho);
      if (x > y) pHome += p;
      else if (x === y) pDraw += p;
      else pAway += p;
    }
  }
  const total = pHome + pDraw + pAway;
  return { pHome: pHome / total, pDraw: pDraw / total, pAway: pAway / total };
}

// ==========================================
// CORE SIMULATORE MONTE CARLO PER SINGOLA LEGA
// ==========================================
async function runSimulationForLeague(div, env) {
  const regola = await env.DB_ARCHIVIO.prepare('SELECT * FROM regole_leghe WHERE div = ?').bind(div).first();
  if (!regola) {
    return { status: 'saltato', div, motivo: 'Regole non trovate per la lega' };
  }

  // 1. Calcolo stagione in corso tramite data_regressione
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;
  const curDay = now.getUTCDate();
  let targetSeason = `${curYear}`;

  if (regola.data_regressione) {
    const [regM, regD] = regola.data_regressione.split('-').map(Number);
    const isPast = (curMonth > regM) || (curMonth === regM && curDay >= regD);
    targetSeason = (regM <= 9) ? (isPast ? `${curYear}/${curYear + 1}` : `${curYear - 1}/${curYear}`) : (isPast ? `${curYear + 1}` : `${curYear}`);
  }

  const checkSeason = await env.DB_ARCHIVIO.prepare('SELECT season FROM matches WHERE div = ? AND season = ? LIMIT 1').bind(div, targetSeason).first();
  const latestSeason = (await env.DB_ARCHIVIO.prepare('SELECT season FROM matches WHERE div = ? ORDER BY season DESC LIMIT 1').bind(div).first())?.season;
  const activeSeason = checkSeason ? targetSeason : latestSeason;

  if (!activeSeason) {
    return { status: 'saltato', div, motivo: 'Nessuna partita registrata nel database' };
  }

  // 2. Lettura Parametro Rho (Dixon-Coles)
  const rhoRow = await env.DB_PRONOSTICI.prepare('SELECT current_rho FROM parametri_campionato WHERE campionato = ?').bind(div).first();
  const rho = rhoRow ? rhoRow.current_rho : -0.10;

  // 3. Squadre e rating (Classifica Elite per team_id)
  const { results: eliteTeams } = await env.DB_ARCHIVIO.prepare('SELECT team_id, nome_display, attacco, difesa, h_factor, elo_perf FROM classifica_elite WHERE ultima_div = ?').bind(div).all();
  const teamMap = new Map();
  eliteTeams.forEach(t => teamMap.set(String(t.team_id), t));

  // 4. Partite disputate
  const { results: playedMatches } = await env.DB_ARCHIVIO.prepare(
    'SELECT home_team_id, away_team_id, fthg, ftag FROM matches WHERE div = ? AND season = ? AND fthg IS NOT NULL AND ftag IS NOT NULL'
  ).bind(div, activeSeason).all();

  const uniqueTeamsInSeason = new Set();
  playedMatches.forEach(m => {
    if (m.home_team_id) uniqueTeamsInSeason.add(String(m.home_team_id));
    if (m.away_team_id) uniqueTeamsInSeason.add(String(m.away_team_id));
  });

  // Se non tutte le squadre hanno debuttato
  if (regola.num_squadre && uniqueTeamsInSeason.size < regola.num_squadre) {
    return { status: 'saltato', div, motivo: `Squadre attive insufficienti (${uniqueTeamsInSeason.size}/${regola.num_squadre})` };
  }

  // 5. Calcolo classifica reale
  const currentStats = {};
  uniqueTeamsInSeason.forEach(id => {
    currentStats[id] = { pts: 0, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
  });

  playedMatches.forEach(m => {
    const h = String(m.home_team_id);
    const a = String(m.away_team_id);
    if (currentStats[h] && currentStats[a]) {
      currentStats[h].p++; currentStats[a].p++;
      currentStats[h].gf += m.fthg; currentStats[h].ga += m.ftag;
      currentStats[a].gf += m.ftag; currentStats[a].ga += m.fthg;
      if (m.fthg > m.ftag) { currentStats[h].w++; currentStats[a].l++; currentStats[h].pts += 3; }
      else if (m.fthg === m.ftag) { currentStats[h].d++; currentStats[a].d++; currentStats[h].pts += 1; currentStats[a].pts += 1; }
      else { currentStats[a].w++; currentStats[h].l++; currentStats[a].pts += 3; }
    }
  });

  // 6. Generazione partite restanti (Round-Robin Subtraction)
  const playedPairs = new Set(playedMatches.map(m => `${m.home_team_id}_${m.away_team_id}`));
  const remainingMatches = [];
  const teamsArr = Array.from(uniqueTeamsInSeason);

  for (let i = 0; i < teamsArr.length; i++) {
    for (let j = 0; j < teamsArr.length; j++) {
      if (i !== j) {
        const pair = `${teamsArr[i]}_${teamsArr[j]}`;
        if (!playedPairs.has(pair)) {
          const hTeam = teamMap.get(teamsArr[i]) || { attacco: 1.0, difesa: 1.0, h_factor: 25 };
          const aTeam = teamMap.get(teamsArr[j]) || { attacco: 1.0, difesa: 1.0, h_factor: 25 };
          const probs = calculateMatchProbabilities(hTeam, aTeam, rho);
          remainingMatches.push({ h: teamsArr[i], a: teamsArr[j], probs });
        }
      }
    }
  }

  // 7. Simulazione Monte Carlo (2.500 Iterazioni)
  const ITERATIONS = 2500;
  const simResults = {};
  teamsArr.forEach(id => {
    simResults[id] = { totalPts: 0, title: 0, ucl: 0, uel: 0, uecl: 0, promo: 0, playoff: 0, playout: 0, retro: 0 };
  });

  for (let it = 0; it < ITERATIONS; it++) {
    const table = {};
    teamsArr.forEach(id => {
      table[id] = { id, pts: currentStats[id].pts };
    });

    for (let m = 0; m < remainingMatches.length; m++) {
      const match = remainingMatches[m];
      const rnd = Math.random();
      if (rnd < match.probs.pHome) {
        table[match.h].pts += 3;
      } else if (rnd < (match.probs.pHome + match.probs.pDraw)) {
        table[match.h].pts += 1;
        table[match.a].pts += 1;
      } else {
        table[match.a].pts += 3;
      }
    }

    const sorted = Object.values(table).sort((a, b) => b.pts - a.pts);
    const N = sorted.length;
    const uclEnd = regola.posti_ucl || 0;
    const uelEnd = uclEnd + (regola.posti_uel || 0);
    const ueclEnd = uelEnd + (regola.posti_uecl || 0);
    const promoEnd = regola.posti_promo || 0;
    const playoffEnd = promoEnd + (regola.playoff || 0);
    const retroCount = regola.posti_retro || 0;
    const playoutCount = regola.playout || 0;

    for (let pos = 0; pos < N; pos++) {
      const id = sorted[pos].id;
      simResults[id].totalPts += sorted[pos].pts;
      if (pos === 0) simResults[id].title++;
      if (uclEnd > 0 && pos < uclEnd) simResults[id].ucl++;
      if (uelEnd > uclEnd && pos >= uclEnd && pos < uelEnd) simResults[id].uel++;
      if (ueclEnd > uelEnd && pos >= uelEnd && pos < ueclEnd) simResults[id].uecl++;
      if (promoEnd > 0 && pos < promoEnd) simResults[id].promo++;
      if (playoffEnd > promoEnd && pos >= promoEnd && pos < playoffEnd) simResults[id].playoff++;
      if (retroCount > 0 && pos >= (N - retroCount)) simResults[id].retro++;
      if (playoutCount > 0 && pos >= (N - retroCount - playoutCount) && pos < (N - retroCount)) simResults[id].playout++;
    }
  }

  // 8. Calcolo Motivazione (Curva di attivazione)
  const avgPlayed = playedMatches.length / (teamsArr.length / 2);
  const totalRounds = regola.giornate_totali || ((teamsArr.length - 1) * 2);
  const progressRatio = Math.min(1.0, avgPlayed / totalRounds);
  const updateDate = new Date().toISOString();
  const statements = [];

  for (let i = 0; i < teamsArr.length; i++) {
    const id = teamsArr[i];
    const res = simResults[id];
    const teamObj = teamMap.get(id);
    const teamName = teamObj ? teamObj.nome_display : `Team ${id}`;

    const pTitolo = (res.title / ITERATIONS) * 100;
    const pUcl = (res.ucl / ITERATIONS) * 100;
    const pUel = (res.uel / ITERATIONS) * 100;
    const pUecl = (res.uecl / ITERATIONS) * 100;
    const pPromo = (res.promo / ITERATIONS) * 100;
    const pPlayoff = (res.playoff / ITERATIONS) * 100;
    const pPlayout = (res.playout / ITERATIONS) * 100;
    const pRetro = (res.retro / ITERATIONS) * 100;
    const projPts = Number((res.totalPts / ITERATIONS).toFixed(1));

    let motivation = 1.00;
    if (progressRatio > 0.50) {
      const progWeight = (progressRatio - 0.50) / 0.50;
      const probs = [pTitolo, pUcl, pUel, pUecl, pPromo, pPlayoff, pPlayout, pRetro].map(p => p / 100);
      const maxTension = Math.max(...probs.map(p => 4 * p * (1 - p)));

      let delta = 0;
      if (maxTension > 0.15) {
        delta = 0.10 * maxTension;
      } else {
        delta = -0.10 * (1 - maxTension);
      }
      motivation = Number((1.00 + (delta * progWeight)).toFixed(3));
      motivation = Math.max(0.90, Math.min(1.10, motivation));
    }

    statements.push(env.DB_SOGLIE.prepare(`
      INSERT INTO proiezioni_campionato 
        (div, season, team_id, team_name, punti_attuali, punti_proiettati, prob_titolo, prob_ucl, prob_uel, prob_uecl, prob_promo, prob_playoff, prob_playout, prob_retro, fattore_motivazione, data_aggiornamento)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(div, season, team_id) DO UPDATE SET
        team_name=excluded.team_name,
        punti_attuali=excluded.punti_attuali,
        punti_proiettati=excluded.punti_proiettati,
        prob_titolo=excluded.prob_titolo,
        prob_ucl=excluded.prob_ucl,
        prob_uel=excluded.prob_uel,
        prob_uecl=excluded.prob_uecl,
        prob_promo=excluded.prob_promo,
        prob_playoff=excluded.prob_playoff,
        prob_playout=excluded.prob_playout,
        prob_retro=excluded.prob_retro,
        fattore_motivazione=excluded.fattore_motivazione,
        data_aggiornamento=excluded.data_aggiornamento
    `).bind(
      div, activeSeason, id, teamName,
      currentStats[id].pts, projPts,
      Number(pTitolo.toFixed(1)), Number(pUcl.toFixed(1)), Number(pUel.toFixed(1)), Number(pUecl.toFixed(1)),
      Number(pPromo.toFixed(1)), Number(pPlayoff.toFixed(1)), Number(pPlayout.toFixed(1)), Number(pRetro.toFixed(1)),
      motivation, updateDate
    ));
  }

  await env.DB_SOGLIE.batch(statements);
  return { status: 'completato', div, season: activeSeason, partite_simulate: remainingMatches.length };
}

// ==========================================
// WORKER ROUTER & INTERFACCIA
// ==========================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // -------------------------------------------------------------
    // 1. ENDPOINT CRON A ROTAZIONE (Solo campionati attivi)
    // -------------------------------------------------------------
    if (url.pathname === '/api/cron/simulate-next') {
      const key = url.searchParams.get('key');
      const cronKey = env.CRON_KEY || 'segreto_montecarlo_2026';

      if (key !== cronKey) {
        return new Response(JSON.stringify({ error: 'Non autorizzato' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }

      // Estrae SOLO i campionati con is_active = 1
      const activeDivsResult = await env.DB_ARCHIVIO.prepare(`
        SELECT r.div 
        FROM regole_leghe r
        INNER JOIN leagues l ON r.div = l.id
        WHERE l.is_active = 1
        ORDER BY r.div ASC
      `).all();

      const activeLeagueList = activeDivsResult.results.map(r => r.div);

      if (activeLeagueList.length === 0) {
        return new Response(JSON.stringify({ status: 'saltato', motivo: 'Nessun campionato attivo con is_active = 1' }), { headers: { 'Content-Type': 'application/json' } });
      }

      let chosenDiv = activeLeagueList[0];
      try {
        const oldest = await env.DB_SOGLIE.prepare(`
          SELECT div, MAX(data_aggiornamento) as last_up 
          FROM proiezioni_campionato 
          GROUP BY div 
          ORDER BY last_up ASC
        `).all();

        const updatedMap = new Map(oldest.results.map(r => [r.div, r.last_up]));
        const neverSimulated = activeLeagueList.find(d => !updatedMap.has(d));

        if (neverSimulated) {
          chosenDiv = neverSimulated;
        } else {
          // Seleziona il campionato attivo con il timestamp più vecchio
          const sortedActive = activeLeagueList.slice().sort((a, b) => {
            const timeA = new Date(updatedMap.get(a) || 0).getTime();
            const timeB = new Date(updatedMap.get(b) || 0).getTime();
            return timeA - timeB;
          });
          chosenDiv = sortedActive[0];
        }
      } catch (err) {}

      try {
        const result = await runSimulationForLeague(chosenDiv, env);
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        // Ritorna sempre 200 OK per evitare il blocco di cron-job.org
        return new Response(JSON.stringify({ status: 'errore_gestito', div: chosenDiv, errore: err.message }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // -------------------------------------------------------------
    // 2. API: Lista Leghe Attive (Dropdown)
    // -------------------------------------------------------------
    if (url.pathname === '/api/leagues') {
      const { results } = await env.DB_ARCHIVIO.prepare(`
        SELECT r.div, r.nazione, r.bandiera 
        FROM regole_leghe r
        INNER JOIN leagues l ON r.div = l.id
        WHERE l.is_active = 1
        ORDER BY r.div ASC
      `).all();

      return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
    }

    // -------------------------------------------------------------
    // 3. API: Dati Classifiche (Reale + Proiettata)
    // -------------------------------------------------------------
    if (url.pathname === '/api/data') {
      const div = url.searchParams.get('div');
      if (!div) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });

      const regola = await env.DB_ARCHIVIO.prepare('SELECT * FROM regole_leghe WHERE div = ?').bind(div).first();
      const now = new Date();
      const curYear = now.getUTCFullYear();
      const curMonth = now.getUTCMonth() + 1;
      const curDay = now.getUTCDate();
      let targetSeason = `${curYear}`;

      if (regola && regola.data_regressione) {
        const [regM, regD] = regola.data_regressione.split('-').map(Number);
        const isPast = (curMonth > regM) || (curMonth === regM && curDay >= regD);
        targetSeason = (regM <= 9) ? (isPast ? `${curYear}/${curYear + 1}` : `${curYear - 1}/${curYear}`) : (isPast ? `${curYear + 1}` : `${curYear}`);
      }

      const checkSeason = await env.DB_ARCHIVIO.prepare('SELECT season FROM matches WHERE div = ? AND season = ? LIMIT 1').bind(div, targetSeason).first();
      let activeSeason = checkSeason ? targetSeason : (await env.DB_ARCHIVIO.prepare('SELECT season FROM matches WHERE div = ? ORDER BY season DESC LIMIT 1').bind(div).first())?.season;

      // Classifica Reale con calcolo matematico certo (V*3 + N)
      const queryReale = `
        WITH stats AS (
          SELECT hometeam AS team, 1 AS p, CASE WHEN fthg > ftag THEN 1 ELSE 0 END AS w, CASE WHEN fthg = ftag THEN 1 ELSE 0 END AS d, CASE WHEN fthg < ftag THEN 1 ELSE 0 END AS l, fthg AS gf, ftag AS ga FROM matches WHERE div = ? AND season = ? AND fthg IS NOT NULL AND ftag IS NOT NULL
          UNION ALL
          SELECT awayteam AS team, 1 AS p, CASE WHEN ftag > fthg THEN 1 ELSE 0 END AS w, CASE WHEN ftag = fthg THEN 1 ELSE 0 END AS d, CASE WHEN ftag < fthg THEN 1 ELSE 0 END AS l, ftag AS gf, fthg AS ga FROM matches WHERE div = ? AND season = ? AND fthg IS NOT NULL AND ftag IS NOT NULL
        )
        SELECT team, (SUM(w) * 3 + SUM(d)) AS pts, SUM(p) AS p, SUM(w) AS w, SUM(d) AS d, SUM(l) AS l, SUM(gf) AS gf, SUM(ga) AS ga, (SUM(gf) - SUM(ga)) AS gd
        FROM stats GROUP BY team ORDER BY pts DESC, gd DESC, gf DESC, team ASC;
      `;
      const { results: reale } = await env.DB_ARCHIVIO.prepare(queryReale).bind(div, activeSeason, div, activeSeason).all();

      // Classifica Proiettata da DB_SOGLIE
      let proiezioni = [];
      try {
        const { results: proj } = await env.DB_SOGLIE.prepare(
          'SELECT * FROM proiezioni_campionato WHERE div = ? AND season = ? ORDER BY punti_proiettati DESC'
        ).bind(div, activeSeason).all();
        proiezioni = proj;
      } catch (e) {}

      return new Response(JSON.stringify({
        div,
        season: activeSeason,
        bandiera: regola?.bandiera || '',
        nazione: regola?.nazione || '',
        reale,
        proiezioni
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // -------------------------------------------------------------
    // 4. Pagina Web Minimale (Font 10px, Due Tabelle Sovrapposte)
    // -------------------------------------------------------------
    const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classifiche & Proiezioni</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 10px;
      margin: 10px;
      background: #fdfdfd;
      color: #111;
    }
    .header {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }
    select {
      font-size: 10px;
      padding: 2px 4px;
      border: 1px solid #bbb;
      border-radius: 3px;
      background: #fff;
    }
    .section-title {
      font-size: 11px;
      font-weight: 700;
      margin: 12px 0 4px 0;
      color: #333;
      display: flex;
      justify-content: space-between;
      max-width: 820px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      max-width: 820px;
      background: #fff;
      margin-bottom: 15px;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 3px 5px;
      text-align: center;
      white-space: nowrap;
    }
    th {
      background-color: #f2f2f2;
      font-weight: 600;
    }
    td.team {
      text-align: left;
      font-weight: 500;
    }
    tr:nth-child(even) {
      background-color: #fafafa;
    }
    .mot-high { color: #007a00; font-weight: bold; }
    .mot-low { color: #b00000; }
    .mot-mid { color: #666; }
    .loading { color: #777; font-style: italic; }
  </style>
</head>
<body>

  <div class="header">
    <label>Campionato: <select id="leagueSelect"><option>Caricamento...</option></select></label>
    <span id="seasonDisplay" style="font-weight:bold; color:#444;"></span>
    <span id="status" class="loading"></span>
  </div>

  <div class="section-title">
    <span>1. CLASSIFICA ATTUALE REALE</span>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:20px;">#</th>
        <th style="text-align:left;">Squadra</th>
        <th style="width:25px;">PT</th>
        <th style="width:20px;">G</th>
        <th style="width:20px;">V</th>
        <th style="width:20px;">N</th>
        <th style="width:20px;">P</th>
        <th style="width:22px;">GF</th>
        <th style="width:22px;">GS</th>
        <th style="width:25px;">DR</th>
      </tr>
    </thead>
    <tbody id="realeBody">
      <tr><td colspan="10">Caricamento...</td></tr>
    </tbody>
  </table>

  <div class="section-title">
    <span>2. PROIEZIONE MONTE CARLO & MOTIVAZIONE</span>
    <span id="updateTag" style="font-weight:normal; font-size:9px; color:#666;"></span>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:20px;">#</th>
        <th style="text-align:left;">Squadra</th>
        <th style="width:28px;">PT Att</th>
        <th style="width:30px;">PT Proj</th>
        <th style="width:26px;">% 1°</th>
        <th style="width:26px;">% UCL</th>
        <th style="width:26px;">% UEL</th>
        <th style="width:26px;">% UECL</th>
        <th style="width:26px;">% Prom</th>
        <th style="width:26px;">% Playoff</th>
        <th style="width:26px;">% Playout</th>
        <th style="width:26px;">% Retr</th>
        <th style="width:32px;">Motiv (M)</th>
      </tr>
    </thead>
    <tbody id="projBody">
      <tr><td colspan="13">Nessuna simulazione disponibile per questa lega.</td></tr>
    </tbody>
  </table>

  <script>
    const leagueSelect = document.getElementById('leagueSelect');
    const seasonDisplay = document.getElementById('seasonDisplay');
    const realeBody = document.getElementById('realeBody');
    const projBody = document.getElementById('projBody');
    const updateTag = document.getElementById('updateTag');
    const status = document.getElementById('status');

    async function init() {
      const leagues = await fetch('/api/leagues').then(r => r.json());
      leagueSelect.innerHTML = leagues.map(l => {
        const flag = l.bandiera ? l.bandiera + ' ' : '';
        return \`<option value="\${l.div}">\${flag}\${l.div}</option>\`;
      }).join('');

      const savedLeague = localStorage.getItem('selected_div');
      if (savedLeague && leagues.some(l => l.div === savedLeague)) {
        leagueSelect.value = savedLeague;
      }
      loadData();
    }

    async function loadData() {
      const div = leagueSelect.value;
      if (!div) return;
      localStorage.setItem('selected_div', div);
      status.textContent = 'Caricamento...';

      const data = await fetch(\`/api/data?div=\${encodeURIComponent(div)}\`).then(r => r.json());
      status.textContent = '';
      seasonDisplay.textContent = \`Stagione \${data.season}\`;

      // Render Classifica Reale
      if (!data.reale || data.reale.length === 0) {
        realeBody.innerHTML = '<tr><td colspan="10">Nessuna partita registrata.</td></tr>';
      } else {
        realeBody.innerHTML = data.reale.map((r, i) => \`
          <tr>
            <td>\${i + 1}</td>
            <td class="team">\${r.team}</td>
            <td><b>\${r.pts}</b></td>
            <td>\${r.p}</td>
            <td>\${r.w}</td>
            <td>\${r.d}</td>
            <td>\${r.l}</td>
            <td>\${r.gf}</td>
            <td>\${r.ga}</td>
            <td>\${r.gd > 0 ? '+' + r.gd : r.gd}</td>
          </tr>
        \`).join('');
      }

      // Render Proiezioni Monte Carlo
      if (!data.proiezioni || data.proiezioni.length === 0) {
        projBody.innerHTML = '<tr><td colspan="13" style="padding:8px;">Simulazione Monte Carlo non ancora eseguita.</td></tr>';
        updateTag.textContent = '';
      } else {
        updateTag.textContent = 'Aggiornato: ' + new Date(data.proiezioni[0].data_aggiornamento).toLocaleString('it-IT');
        projBody.innerHTML = data.proiezioni.map((p, i) => {
          let motClass = 'mot-mid';
          if (p.fattore_motivazione >= 1.02) motClass = 'mot-high';
          else if (p.fattore_motivazione <= 0.98) motClass = 'mot-low';

          return \`
            <tr>
              <td>\${i + 1}</td>
              <td class="team">\${p.team_name}</td>
              <td>\${p.punti_attuali}</td>
              <td><b>\${p.punti_proiettati}</b></td>
              <td>\${p.prob_titolo}%</td>
              <td>\${p.prob_ucl}%</td>
              <td>\${p.prob_uel}%</td>
              <td>\${p.prob_uecl}%</td>
              <td>\${p.prob_promo}%</td>
              <td>\${p.prob_playoff}%</td>
              <td>\${p.prob_playout}%</td>
              <td>\${p.prob_retro}%</td>
              <td class="\${motClass}">\${p.fattore_motivazione.toFixed(3)}</td>
            </tr>
          \`;
        }).join('');
      }
    }

    leagueSelect.addEventListener('change', loadData);
    init();
  </script>
</body>
</html>`;

    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
};