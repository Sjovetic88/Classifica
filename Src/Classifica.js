export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. API: Elenco campionati (con bandiere e nazioni da regole_leghe)
    if (url.pathname === '/api/leagues') {
      try {
        const { results } = await env.DB_ARCHIVIO.prepare(`
          SELECT r.div, r.nazione, r.bandiera 
          FROM regole_leghe r
          INNER JOIN (SELECT DISTINCT div FROM matches) m ON r.div = m.div
          ORDER BY r.div ASC
        `).all();

        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        // Fallback su sola tabella matches se regole_leghe non risponde
        const { results } = await env.DB_ARCHIVIO.prepare(
          'SELECT DISTINCT div FROM matches WHERE div IS NOT NULL ORDER BY div ASC'
        ).all();
        return new Response(JSON.stringify(results.map(r => ({ div: r.div }))), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 2. API: Calcolo Classifica Stagione in Corso
    if (url.pathname === '/api/standings') {
      const div = url.searchParams.get('div');
      if (!div) {
        return new Response(JSON.stringify({ error: 'Div mancante' }), { 
          status: 400, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }

      // Recupera la regola della lega
      const regola = await env.DB_ARCHIVIO.prepare(
        'SELECT data_regressione, nazione, bandiera FROM regole_leghe WHERE div = ?'
      ).bind(div).first();

      // Determina la stagione in corso
      const now = new Date();
      const currentYear = now.getUTCFullYear();
      const currentMonth = now.getUTCMonth() + 1;
      const currentDay = now.getUTCDate();

      let targetSeason = '';

      if (regola && regola.data_regressione) {
        const [regM, regD] = regola.data_regressione.split('-').map(Number);
        const isPastRegression = (currentMonth > regM) || (currentMonth === regM && currentDay >= regD);

        // Se la regressione è estiva (es. 07-20), campionato su due anni
        if (regM <= 9) {
          targetSeason = isPastRegression 
            ? `${currentYear}/${currentYear + 1}` 
            : `${currentYear - 1}/${currentYear}`;
        } else {
          // Campionato annuale (es. Brasile/MLS/Argentina)
          targetSeason = isPastRegression ? `${currentYear + 1}` : `${currentYear}`;
        }
      } else {
        // Fallback generico su anno solare
        targetSeason = `${currentYear}`;
      }

      // Verifica se ci sono partite giocate per la stagione calcolata, altrimenti prende la più recente
      const checkSeason = await env.DB_ARCHIVIO.prepare(
        'SELECT season FROM matches WHERE div = ? AND season = ? LIMIT 1'
      ).bind(div, targetSeason).first();

      let activeSeason = targetSeason;
      if (!checkSeason) {
        const latest = await env.DB_ARCHIVIO.prepare(
          'SELECT season FROM matches WHERE div = ? ORDER BY season DESC LIMIT 1'
        ).bind(div).first();
        if (latest) {
          activeSeason = latest.season;
        }
      }

      // Query Classifica con formula matematica garantita (V*3 + N)
      const query = `
        WITH stats AS (
          SELECT 
            hometeam AS team,
            1 AS p,
            CASE WHEN fthg > ftag THEN 1 ELSE 0 END AS w,
            CASE WHEN fthg = ftag THEN 1 ELSE 0 END AS d,
            CASE WHEN fthg < ftag THEN 1 ELSE 0 END AS l,
            fthg AS gf,
            ftag AS ga
          FROM matches
          WHERE div = ? AND season = ? AND fthg IS NOT NULL AND ftag IS NOT NULL
          
          UNION ALL
          
          SELECT 
            awayteam AS team,
            1 AS p,
            CASE WHEN ftag > fthg THEN 1 ELSE 0 END AS w,
            CASE WHEN ftag = fthg THEN 1 ELSE 0 END AS d,
            CASE WHEN ftag < fthg THEN 1 ELSE 0 END AS l,
            ftag AS gf,
            fthg AS ga
          FROM matches
          WHERE div = ? AND season = ? AND fthg IS NOT NULL AND ftag IS NOT NULL
        )
        SELECT 
          team,
          (SUM(w) * 3 + SUM(d)) AS pts,
          SUM(p) AS p,
          SUM(w) AS w,
          SUM(d) AS d,
          SUM(l) AS l,
          SUM(gf) AS gf,
          SUM(ga) AS ga,
          (SUM(gf) - SUM(ga)) AS gd
        FROM stats
        GROUP BY team
        ORDER BY pts DESC, gd DESC, gf DESC, team ASC;
      `;

      const { results } = await env.DB_ARCHIVIO.prepare(query)
        .bind(div, activeSeason, div, activeSeason)
        .all();

      return new Response(JSON.stringify({
        div: div,
        season: activeSeason,
        bandiera: regola?.bandiera || '',
        nazione: regola?.nazione || '',
        standings: results
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Pagina Web minimale (Font 10px)
    const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classifica</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 10px;
      margin: 10px;
      background: #fcfcfc;
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
      border-radius: 2px;
      background: #fff;
    }
    .season-tag {
      font-weight: bold;
      color: #444;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      max-width: 600px;
      background: #fff;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 3px 5px;
      text-align: center;
    }
    th {
      background-color: #f0f0f0;
      font-weight: 600;
    }
    td.team {
      text-align: left;
      font-weight: 500;
    }
    tr:nth-child(even) {
      background-color: #f9f9f9;
    }
    .loading {
      color: #777;
      font-style: italic;
    }
  </style>
</head>
<body>

  <div class="header">
    <label>Lega: <select id="leagueSelect"><option>Caricamento...</option></select></label>
    <span id="seasonDisplay" class="season-tag"></span>
    <span id="status" class="loading"></span>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 22px;">#</th>
        <th style="text-align: left;">Squadra</th>
        <th style="width: 28px;">PT</th>
        <th style="width: 22px;">G</th>
        <th style="width: 22px;">V</th>
        <th style="width: 22px;">N</th>
        <th style="width: 22px;">P</th>
        <th style="width: 24px;">GF</th>
        <th style="width: 24px;">GS</th>
        <th style="width: 28px;">DR</th>
      </tr>
    </thead>
    <tbody id="standingsBody">
      <tr><td colspan="10" style="padding: 8px;">Caricamento...</td></tr>
    </tbody>
  </table>

  <script>
    const leagueSelect = document.getElementById('leagueSelect');
    const seasonDisplay = document.getElementById('seasonDisplay');
    const standingsBody = document.getElementById('standingsBody');
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

      loadStandings();
    }

    async function loadStandings() {
      const div = leagueSelect.value;
      if (!div) return;

      localStorage.setItem('selected_div', div);
      status.textContent = 'Aggiornamento...';

      const data = await fetch(\`/api/standings?div=\${encodeURIComponent(div)}\`).then(r => r.json());
      status.textContent = '';

      seasonDisplay.textContent = \`Stagione \${data.season}\`;

      if (!data.standings || data.standings.length === 0) {
        standingsBody.innerHTML = '<tr><td colspan="10" style="padding: 8px;">Nessuna partita registrata.</td></tr>';
        return;
      }

      standingsBody.innerHTML = data.standings.map((row, index) => \`
        <tr>
          <td>\${index + 1}</td>
          <td class="team">\${row.team}</td>
          <td><b>\${row.pts}</b></td>
          <td>\${row.p}</td>
          <td>\${row.w}</td>
          <td>\${row.d}</td>
          <td>\${row.l}</td>
          <td>\${row.gf}</td>
          <td>\${row.ga}</td>
          <td>\${row.gd > 0 ? '+' + row.gd : row.gd}</td>
        </tr>
      \`).join('');
    }

    leagueSelect.addEventListener('change', loadStandings);
    init();
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};