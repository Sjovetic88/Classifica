export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. API: Lista di tutti i campionati (div)
    if (url.pathname === '/api/leagues') {
      const { results } = await env.DB_ARCHIVIO.prepare(
        'SELECT DISTINCT div FROM matches WHERE div IS NOT NULL ORDER BY div ASC'
      ).all();
      return new Response(JSON.stringify(results.map(r => r.div)), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. API: Lista stagioni per il campionato selezionato
    if (url.pathname === '/api/seasons') {
      const div = url.searchParams.get('div');
      if (!div) return new Response('[]', { headers: { 'Content-Type': 'application/json' } });

      const { results } = await env.DB_ARCHIVIO.prepare(
        'SELECT DISTINCT season FROM matches WHERE div = ? ORDER BY season DESC'
      ).bind(div).all();

      return new Response(JSON.stringify(results.map(r => r.season)), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. API: Calcolo Classifica (Punti, DR, GF)
    if (url.pathname === '/api/standings') {
      const div = url.searchParams.get('div');
      const season = url.searchParams.get('season');

      if (!div || !season) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
      }

      const query = `
        WITH stats AS (
          SELECT 
            hometeam AS team,
            1 AS p,
            CASE WHEN fthg > ftag THEN 1 ELSE 0 END AS w,
            CASE WHEN fthg = ftag THEN 1 ELSE 0 END AS d,
            CASE WHEN fthg < ftag THEN 1 ELSE 0 END AS l,
            fthg AS gf,
            ftag AS ga,
            CASE WHEN fthg > ftag THEN 3 WHEN fthg = ftag THEN 1 ELSE 0 END AS pts
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
            fthg AS ga,
            CASE WHEN ftag > fthg THEN 3 WHEN ftag = ftag THEN 1 ELSE 0 END AS pts
          FROM matches
          WHERE div = ? AND season = ? AND fthg IS NOT NULL AND ftag IS NOT NULL
        )
        SELECT 
          team,
          SUM(pts) AS pts,
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
        .bind(div, season, div, season)
        .all();

      return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 4. Pagina Web (HTML / CSS / JS)
    const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classifica Campionati</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 10px;
      margin: 12px;
      background: #fdfdfd;
      color: #222;
    }
    .controls {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    select {
      font-size: 10px;
      padding: 2px 4px;
      border: 1px solid #ccc;
      border-radius: 3px;
      background: #fff;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      max-width: 650px;
      background: #fff;
    }
    th, td {
      border: 1px solid #e0e0e0;
      padding: 3px 6px;
      text-align: center;
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
    .loading {
      color: #666;
      font-style: italic;
    }
  </style>
</head>
<body>

  <div class="controls">
    <label>Campionato: <select id="leagueSelect"><option>Caricamento...</option></select></label>
    <label>Stagione: <select id="seasonSelect"><option>--</option></select></label>
    <span id="status" class="loading"></span>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 25px;">#</th>
        <th style="text-align: left;">Squadra</th>
        <th style="width: 30px;">PT</th>
        <th style="width: 25px;">G</th>
        <th style="width: 25px;">V</th>
        <th style="width: 25px;">N</th>
        <th style="width: 25px;">P</th>
        <th style="width: 25px;">GF</th>
        <th style="width: 25px;">GS</th>
        <th style="width: 30px;">DR</th>
      </tr>
    </thead>
    <tbody id="standingsBody">
      <tr><td colspan="10" style="padding: 10px;">Seleziona un campionato e una stagione</td></tr>
    </tbody>
  </table>

  <script>
    const leagueSelect = document.getElementById('leagueSelect');
    const seasonSelect = document.getElementById('seasonSelect');
    const standingsBody = document.getElementById('standingsBody');
    const status = document.getElementById('status');

    async function init() {
      const leagues = await fetch('/api/leagues').then(r => r.json());
      leagueSelect.innerHTML = leagues.map(l => \`<option value="\${l}">\${l}</option>\`).join('');

      const savedLeague = localStorage.getItem('last_div');
      const savedSeason = localStorage.getItem('last_season');

      if (savedLeague && leagues.includes(savedLeague)) {
        leagueSelect.value = savedLeague;
      }

      await loadSeasons(savedSeason);
    }

    async function loadSeasons(preferredSeason = null) {
      const div = leagueSelect.value;
      if (!div) return;

      const seasons = await fetch(\`/api/seasons?div=\${encodeURIComponent(div)}\`).then(r => r.json());
      seasonSelect.innerHTML = seasons.map(s => \`<option value="\${s}">\${s}</option>\`).join('');

      if (preferredSeason && seasons.includes(preferredSeason)) {
        seasonSelect.value = preferredSeason;
      }

      saveAndLoadStandings();
    }

    async function loadStandings() {
      const div = leagueSelect.value;
      const season = seasonSelect.value;
      if (!div || !season) return;

      status.textContent = 'Caricamento...';
      const standings = await fetch(\`/api/standings?div=\${encodeURIComponent(div)}&season=\${encodeURIComponent(season)}\`).then(r => r.json());
      status.textContent = '';

      if (standings.length === 0) {
        standingsBody.innerHTML = '<tr><td colspan="10">Nessuna partita trovata per questa selezione.</td></tr>';
        return;
      }

      standingsBody.innerHTML = standings.map((row, index) => \`
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

    function saveAndLoadStandings() {
      localStorage.setItem('last_div', leagueSelect.value);
      localStorage.setItem('last_season', seasonSelect.value);
      loadStandings();
    }

    leagueSelect.addEventListener('change', () => loadSeasons());
    seasonSelect.addEventListener('change', saveAndLoadStandings);

    init();
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};