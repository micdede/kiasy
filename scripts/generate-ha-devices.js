#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const url = (process.env.HOMEASSISTANT_URL || '').replace(/\/$/, '');
const token = process.env.HOMEASSISTANT_TOKEN;
const client = axios.create({
  baseURL: url + '/api',
  timeout: 15000,
  headers: { Authorization: `Bearer ${token}` },
});

const DOMAINS = ['light', 'switch', 'climate', 'cover', 'fan', 'scene'];
const SENSOR_KEYWORDS = ['temperatur', 'temp', 'humidity', 'feuchtig', 'strom', 'power', 'energy', 'batterie', 'battery', 'bewegung', 'motion', 'tür', 'door', 'fenster', 'window', 'lux', 'helligkeit'];

async function main() {
  // 1. Get entities with areas via template API
  const template = `
{% set domains = ['light', 'switch', 'climate', 'cover', 'fan', 'scene', 'sensor', 'binary_sensor', 'automation'] %}
{% for domain in domains %}
{% for state in states[domain] %}
{% set area = area_name(state.entity_id) %}
{{ state.entity_id }}|||{{ state.attributes.friendly_name or state.entity_id }}|||{{ area or 'Unbekannt' }}|||{{ state.state }}
{% endfor %}
{% endfor %}
`.trim();

  const { data: raw } = await client.post('/template', { template });
  const lines = raw.trim().split('\n').filter(l => l.trim());

  // 2. Parse and group by area
  const areas = {};
  for (const line of lines) {
    const parts = line.trim().split('|||');
    if (parts.length < 4) continue;
    const [entity_id, name, area, state] = parts;
    if (!entity_id || !entity_id.includes('.')) continue;

    const domain = entity_id.split('.')[0];

    // Filter: Only include relevant domains + important sensors
    if (domain === 'sensor' || domain === 'binary_sensor') {
      const lower = name.toLowerCase();
      if (!SENSOR_KEYWORDS.some(kw => lower.includes(kw))) continue;
    }
    if (domain === 'automation') continue; // skip automations for now

    // Skip unavailable entities
    if (state === 'unavailable') continue;

    if (!areas[area]) areas[area] = {};
    if (!areas[area][domain]) areas[area][domain] = [];
    areas[area][domain].push({ entity_id: entity_id.trim(), name: name.trim(), state: state.trim() });
  }

  // 3. Generate Markdown
  const domainLabels = {
    light: 'Lichter',
    switch: 'Schalter/Steckdosen',
    climate: 'Heizung/Klima',
    sensor: 'Sensoren',
    binary_sensor: 'Kontakte/Melder',
    cover: 'Rollläden',
    fan: 'Ventilatoren',
    scene: 'Szenen',
  };

  const areaLabels = {
    'arbeitszimmer': 'Arbeitszimmer',
    'arbeitszimmer_2': 'Arbeitszimmer 2',
    'wohnzimmer': 'Wohnzimmer',
    'schlafzimmer': 'Schlafzimmer',
    'kuche': 'Küche',
    'badezimmer': 'Badezimmer',
    'flur': 'Flur',
    'esszimmer': 'Esszimmer',
    'gastezimmer': 'Gästezimmer',
    'keller': 'Keller',
    'terrasse': 'Terrasse',
    'wc': 'WC',
    'speisekammer': 'Speisekammer',
    'hauseingang': 'Hauseingang',
    'wohnmobil': 'Wohnmobil',
    'hardware': 'Hardware/Server',
    'system': 'System',
    'apple_tv_arbeitszimmer': 'Apple TV (AZ)',
    'Unbekannt': 'Ohne Raumzuordnung',
  };

  const domainOrder = ['light', 'switch', 'climate', 'sensor', 'binary_sensor', 'cover', 'fan', 'scene'];
  const areaOrder = [
    'wohnzimmer', 'arbeitszimmer', 'arbeitszimmer_2', 'schlafzimmer', 'kuche',
    'esszimmer', 'badezimmer', 'wc', 'flur', 'gastezimmer', 'keller',
    'terrasse', 'hauseingang', 'wohnmobil', 'hardware', 'system',
    'apple_tv_arbeitszimmer', 'Unbekannt',
  ];

  let md = `# Home Assistant Geräte\n\n`;
  md += `> Auto-generiert am ${new Date().toLocaleDateString('de-DE')}. Bearbeite diese Datei um unwichtige Einträge zu entfernen.\n\n`;

  const sortedAreas = Object.keys(areas).sort((a, b) => {
    const ai = areaOrder.indexOf(a);
    const bi = areaOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const area of sortedAreas) {
    const label = areaLabels[area] || area;
    md += `## ${label}\n\n`;

    const domains = areas[area];
    const sortedDomains = Object.keys(domains).sort((a, b) => {
      return domainOrder.indexOf(a) - domainOrder.indexOf(b);
    });

    for (const domain of sortedDomains) {
      const dlabel = domainLabels[domain] || domain;
      md += `### ${dlabel}\n`;
      md += `| Name | Entity ID | Status |\n`;
      md += `|------|-----------|--------|\n`;
      for (const entity of domains[domain]) {
        md += `| ${entity.name} | \`${entity.entity_id}\` | ${entity.state} |\n`;
      }
      md += `\n`;
    }
  }

  // 4. Write file
  const outPath = path.join(__dirname, '..', 'ha-devices.md');
  fs.writeFileSync(outPath, md);
  console.log(`Geschrieben: ${outPath}`);
  console.log(`${sortedAreas.length} Räume, ${lines.length} Entities gesamt`);
}

main().catch(e => {
  console.error('Fehler:', e.message);
  process.exit(1);
});
