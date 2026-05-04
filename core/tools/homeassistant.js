// homeassistant.js — HA REST-API (states, services, history)

const HA_URL = (process.env.HOMEASSISTANT_URL || "").replace(/\/$/, "");
const HA_TOKEN = process.env.HOMEASSISTANT_TOKEN;

async function ha(method, path, body) {
  if (!HA_TOKEN) throw new Error("HOMEASSISTANT_TOKEN nicht gesetzt");
  const r = await fetch(`${HA_URL}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000)
  });
  if (!r.ok) throw new Error(`HA ${method} ${path}: HTTP ${r.status}`);
  return r.json();
}

export const definitions = [
  {
    name: "ha_states",
    description: "Home-Assistant States. Ohne Param: Übersicht nach Domain. Mit entity_id: Detail. Mit domain: alle Entities einer Domain.",
    input_schema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        domain:    { type: "string", description: "z.B. light, switch, sensor, climate" }
      }
    }
  },
  {
    name: "ha_call",
    description: "Ruft einen Home-Assistant Service auf. Beispiel: domain=light, service=turn_on, entity_id=light.kueche",
    input_schema: {
      type: "object",
      properties: {
        domain:      { type: "string" },
        service:     { type: "string" },
        entity_id:   { type: "string" },
        service_data: { type: "object", description: "Zusätzliche Service-Parameter" }
      },
      required: ["domain", "service"]
    }
  },
  {
    name: "ha_toggle",
    description: "Schaltet eine Entity um (light, switch, fan, cover etc.).",
    input_schema: {
      type: "object",
      properties: { entity_id: { type: "string" } },
      required: ["entity_id"]
    }
  }
];

export async function execute(name, input) {
  if (name === "ha_states") {
    if (input?.entity_id) {
      return await ha("GET", `/states/${input.entity_id}`);
    }
    const all = await ha("GET", "/states");
    if (input?.domain) {
      return all.filter(s => s.entity_id.startsWith(`${input.domain}.`))
                .map(s => ({ entity_id: s.entity_id, state: s.state, name: s.attributes?.friendly_name }));
    }
    // Übersicht: nach Domain gruppiert
    const grouped = {};
    for (const s of all) {
      const dom = s.entity_id.split(".")[0];
      grouped[dom] = (grouped[dom] || 0) + 1;
    }
    return { total: all.length, by_domain: grouped };
  }

  if (name === "ha_call") {
    const data = { ...(input.service_data || {}) };
    if (input.entity_id) data.entity_id = input.entity_id;
    const result = await ha("POST", `/services/${input.domain}/${input.service}`, data);
    return { service: `${input.domain}.${input.service}`, changed: result.length, result };
  }

  if (name === "ha_toggle") {
    const dom = input.entity_id.split(".")[0];
    return await execute("ha_call", { domain: dom, service: "toggle", entity_id: input.entity_id });
  }

  throw new Error(`unknown: ${name}`);
}
