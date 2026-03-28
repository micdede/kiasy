const axios = require('axios');

const HA_URL = (process.env.HOMEASSISTANT_URL || 'http://homeassistant.local:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HOMEASSISTANT_TOKEN;

function haClient() {
  if (!HA_TOKEN) throw new Error('HOMEASSISTANT_TOKEN nicht konfiguriert');
  return axios.create({
    baseURL: `${HA_URL}/api`,
    timeout: 10000,
    headers: {
      'Authorization': `Bearer ${HA_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

const definitions = [
  {
    name: 'ha_get_states',
    description: 'Home Assistant Entities abfragen. Ohne Parameter: Übersicht aller Entities gruppiert nach Domain. Mit entity_id: Detailstatus. Mit domain: alle Entities einer Domain (z.B. light, switch, sensor, climate).',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Bestimmte Entity abfragen, z.B. "light.wohnzimmer" oder "sensor.temperatur"',
        },
        domain: {
          type: 'string',
          description: 'Nur Entities einer Domain anzeigen, z.B. "light", "switch", "sensor", "climate"',
        },
      },
      required: [],
    },
  },
  {
    name: 'ha_call_service',
    description: 'Home Assistant Service aufrufen. Damit kannst du Geräte steuern: Lichter schalten, Helligkeit/Farbe ändern, Heizung einstellen, Szenen aktivieren, etc.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Service-Domain, z.B. "light", "switch", "climate", "scene", "automation"',
        },
        service: {
          type: 'string',
          description: 'Service-Name, z.B. "turn_on", "turn_off", "toggle", "set_temperature"',
        },
        entity_id: {
          type: 'string',
          description: 'Ziel-Entity, z.B. "light.wohnzimmer"',
        },
        data: {
          type: 'object',
          description: 'Zusätzliche Parameter als JSON, z.B. {"brightness": 128} oder {"temperature": 21}',
        },
      },
      required: ['domain', 'service', 'entity_id'],
    },
  },
  {
    name: 'ha_toggle',
    description: 'Schnelles Ein-/Ausschalten einer Entity (Licht, Schalter, etc.). Shortcut für den häufigsten Anwendungsfall.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Entity zum Umschalten, z.B. "light.wohnzimmer" oder "switch.steckdose"',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'ha_history',
    description: 'Verlauf/Historie einer Home Assistant Entity abfragen. Zeigt Zustandsänderungen der letzten Stunden.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Entity für den Verlauf, z.B. "sensor.temperatur_schlafzimmer"',
        },
        hours: {
          type: 'number',
          description: 'Zeitraum in Stunden (Standard: 24)',
        },
      },
      required: ['entity_id'],
    },
  },
];

async function execute(name, input) {
  const client = haClient();

  if (name === 'ha_get_states') {
    return await getStates(client, input);
  }
  if (name === 'ha_call_service') {
    return await callService(client, input);
  }
  if (name === 'ha_toggle') {
    return await toggle(client, input);
  }
  if (name === 'ha_history') {
    return await getHistory(client, input);
  }

  throw new Error(`Unbekanntes Tool: ${name}`);
}

async function getStates(client, { entity_id, domain }) {
  try {
    // Einzelne Entity
    if (entity_id) {
      const { data } = await client.get(`/states/${entity_id}`);
      return formatEntityDetail(data);
    }

    // Alle States holen
    const { data: states } = await client.get('/states');

    // Nach Domain filtern
    if (domain) {
      const filtered = states.filter(s => s.entity_id.startsWith(`${domain}.`));
      if (filtered.length === 0) return `Keine Entities in Domain "${domain}" gefunden.`;
      let result = `*${domain}* — ${filtered.length} Entities:\n\n`;
      for (const entity of filtered) {
        result += formatEntityShort(entity);
      }
      return result;
    }

    // Übersicht gruppiert nach Domain
    const grouped = {};
    for (const entity of states) {
      const d = entity.entity_id.split('.')[0];
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(entity);
    }

    let result = `*Home Assistant Übersicht* — ${states.length} Entities\n\n`;
    const sortedDomains = Object.keys(grouped).sort();
    for (const d of sortedDomains) {
      const entities = grouped[d];
      result += `*${d}* (${entities.length}):\n`;
      for (const entity of entities) {
        result += formatEntityShort(entity);
      }
      result += '\n';
    }
    return result;

  } catch (error) {
    return handleError('States abrufen', error);
  }
}

async function callService(client, { domain, service, entity_id, data: serviceData }) {
  try {
    const payload = { entity_id };
    if (serviceData && typeof serviceData === 'object') {
      Object.assign(payload, serviceData);
    }

    await client.post(`/services/${domain}/${service}`, payload);

    // Kurz warten, dann aktuellen Status holen
    await new Promise(r => setTimeout(r, 500));
    try {
      const { data: state } = await client.get(`/states/${entity_id}`);
      return `Service *${domain}.${service}* ausgeführt.\n\n` + formatEntityDetail(state);
    } catch {
      return `Service *${domain}.${service}* erfolgreich ausgeführt für ${entity_id}.`;
    }

  } catch (error) {
    return handleError(`Service ${domain}.${service}`, error);
  }
}

async function toggle(client, { entity_id }) {
  try {
    const domain = entity_id.split('.')[0];

    // Homeassistant toggle funktioniert für die meisten Domains
    await client.post('/services/homeassistant/toggle', { entity_id });

    // Status nach Toggle holen
    await new Promise(r => setTimeout(r, 500));
    const { data: state } = await client.get(`/states/${entity_id}`);
    return `*${entity_id}* umgeschaltet → *${state.state}*\n\n` + formatEntityDetail(state);

  } catch (error) {
    return handleError('Toggle', error);
  }
}

async function getHistory(client, { entity_id, hours = 24 }) {
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);
    const timestamp = startTime.toISOString();

    const { data } = await client.get(`/history/period/${timestamp}`, {
      params: {
        filter_entity_id: entity_id,
        minimal_response: true,
        end_time: endTime.toISOString(),
      },
    });

    if (!data || data.length === 0 || data[0].length === 0) {
      return `Kein Verlauf für *${entity_id}* in den letzten ${hours} Stunden.`;
    }

    const entries = data[0];
    let result = `*Verlauf: ${entity_id}* (letzte ${hours}h) — ${entries.length} Einträge:\n\n`;

    // Letzte 30 Einträge zeigen
    const recent = entries.slice(-30);
    for (const entry of recent) {
      const time = new Date(entry.last_changed || entry.last_updated).toLocaleString('de-DE', {
        timeZone: process.env.TZ || 'Europe/Berlin',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      result += `${time} → *${entry.state}*\n`;
    }

    if (entries.length > 30) {
      result += `\n_(${entries.length - 30} ältere Einträge ausgeblendet)_`;
    }

    return result;

  } catch (error) {
    return handleError('Verlauf abrufen', error);
  }
}

// --- Hilfsfunktionen ---

function formatEntityShort(entity) {
  const name = entity.attributes?.friendly_name || entity.entity_id;
  const state = entity.state;
  const unit = entity.attributes?.unit_of_measurement || '';
  return `  • ${name}: *${state}*${unit ? ' ' + unit : ''}\n`;
}

function formatEntityDetail(entity) {
  const name = entity.attributes?.friendly_name || entity.entity_id;
  let result = `*${name}* (${entity.entity_id})\n`;
  result += `Status: *${entity.state}*\n`;

  const attrs = entity.attributes || {};
  const skip = ['friendly_name', 'supported_features', 'icon', 'entity_picture'];

  for (const [key, value] of Object.entries(attrs)) {
    if (skip.includes(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    result += `${key}: ${value}\n`;
  }

  if (entity.last_changed) {
    const changed = new Date(entity.last_changed).toLocaleString('de-DE', {
      timeZone: process.env.TZ || 'Europe/Berlin',
    });
    result += `Letzte Änderung: ${changed}\n`;
  }

  return result;
}

function handleError(action, error) {
  if (error.response) {
    const status = error.response.status;
    if (status === 401) return `❌ Home Assistant: Authentifizierung fehlgeschlagen. Token prüfen.`;
    if (status === 404) return `❌ Home Assistant: Entity oder Service nicht gefunden.`;
    return `❌ Home Assistant Fehler bei ${action}: ${status} — ${error.response.data?.message || error.message}`;
  }
  if (error.code === 'ECONNREFUSED') return `❌ Home Assistant nicht erreichbar unter ${HA_URL}. Läuft der Server?`;
  if (error.code === 'ETIMEDOUT') return `❌ Home Assistant Timeout — Server antwortet nicht.`;
  return `❌ Fehler bei ${action}: ${error.message}`;
}

module.exports = { definitions, execute };
