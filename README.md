# Uren- en Verlofregistratie Tool (VOF)

Simpele web-tool voor 3 vennoten om gewerkte uren en verlof bij te houden.

## Starten

Geen dependencies nodig (alleen Node.js ≥ 18):

```bash
node server.js
```

Open vervolgens http://localhost:3000

De data wordt opgeslagen in `data.json` in dezelfde map.

## Functies

- **Gebruiker kiezen** bovenaan — 3 vennoten, snel switchen
- **Invoer** — uren per dag snel toevoegen, incl. notities
- **Verlof** — verlofuren opnemen (8 u = 1 dag), telt standaard mee als gewerkt tot norm
- **Dashboard** — deze week, verschil t.o.v. norm, saldo over tijd, verlofstatus, weekgrafiek
- **Team** — vergelijking tussen de 3 vennoten + grafiek
- **Instellingen** — naam, weeknorm, verlofuren per jaar, startdatum saldo, verlof-telt-als-gewerkt toggle
- **CSV export** via de instellingen-tab

## Techniek

- Node.js (ingebouwde `http` module — geen npm install)
- JSON file storage (`data.json`)
- Vanilla HTML/CSS/JS frontend — mobile-friendly

## Deployen

Draait standalone. Kun je achter een reverse proxy (nginx/Caddy) zetten, of via `PORT=8080 node server.js` op een andere poort.
