// weather.js — Open-Meteo (kein API-Key nötig)

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const WEATHER_CODES = {
  0:"Klar",1:"Überw. klar",2:"Teilw. bewölkt",3:"Bedeckt",
  45:"Nebel",48:"Bereifungsnebel",
  51:"Leichter Niesel",53:"Mäß. Niesel",55:"Starker Niesel",
  61:"Leichter Regen",63:"Mäß. Regen",65:"Starker Regen",
  71:"Leichter Schnee",73:"Mäß. Schnee",75:"Starker Schnee",
  80:"Leichte Schauer",81:"Schauer",82:"Heftige Schauer",
  95:"Gewitter",96:"Gewitter mit Hagel",99:"Gewitter mit starkem Hagel"
};

export const definitions = [
  {
    name: "weather_current",
    description: "Aktuelles Wetter für einen Ort (Open-Meteo, kein Key nötig).",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Ortsname (z.B. 'Witten')" }
      },
      required: ["location"]
    }
  },
  {
    name: "weather_forecast",
    description: "Wettervorhersage für N Tage (max 7).",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string" },
        days:     { type: "integer", default: 3 }
      },
      required: ["location"]
    }
  }
];

async function geocode(location) {
  const url = `${GEO_URL}?name=${encodeURIComponent(location)}&count=1&language=de`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await r.json();
  if (!data.results?.length) throw new Error(`Ort nicht gefunden: ${location}`);
  const g = data.results[0];
  return { name: `${g.name}, ${g.country}`, lat: g.latitude, lon: g.longitude };
}

export async function execute(name, input) {
  const loc = await geocode(input.location);

  if (name === "weather_current") {
    const url = `${FORECAST_URL}?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=Europe%2FBerlin`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    const c = data.current;
    return {
      location: loc.name,
      temperature: `${c.temperature_2m}°C`,
      condition: WEATHER_CODES[c.weather_code] || `Code ${c.weather_code}`,
      wind: `${c.wind_speed_10m} km/h`,
      humidity: `${c.relative_humidity_2m}%`
    };
  }

  if (name === "weather_forecast") {
    const days = Math.min(input.days || 3, 7);
    const url = `${FORECAST_URL}?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_min,temperature_2m_max,weather_code,precipitation_sum&forecast_days=${days}&timezone=Europe%2FBerlin`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    const d = data.daily;
    const forecast = d.time.map((day, i) => ({
      date: day,
      tmin: `${d.temperature_2m_min[i]}°C`,
      tmax: `${d.temperature_2m_max[i]}°C`,
      condition: WEATHER_CODES[d.weather_code[i]] || `Code ${d.weather_code[i]}`,
      precipitation: `${d.precipitation_sum[i]} mm`
    }));
    return { location: loc.name, forecast };
  }

  throw new Error(`unknown: ${name}`);
}
