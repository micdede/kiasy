// Open-Meteo Wetter Tool
// API: https://open-meteo.com/

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

// Wettercode zu Deutsch
const WEATHER_CODES = {
  0: 'Klarer Himmel ☀️',
  1: 'Überwiegend klar',
  2: 'Teilweise bewölkt',
  3: 'Bedeckt',
  45: 'Nebel',
  48: 'Bereifungsnebel',
  51: 'Leichter Nieselregen',
  53: 'Mäßiger Nieselregen',
  55: 'Starker Nieselregen',
  56: 'Gefrierender Nieselregen (leicht)',
  57: 'Gefrierender Nieselregen (dicht)',
  61: 'Leichter Regen 🌧️',
  63: 'Mäßiger Regen',
  65: 'Starker Regen',
  66: 'Gefrierender Regen (leicht)',
  67: 'Gefrierender Regen (stark)',
  71: 'Leichter Schneefall 🌨️',
  73: 'Mäßiger Schneefall',
  75: 'Starker Schneefall',
  77: 'Schneekörner',
  80: 'Leichte Regenschauer',
  81: 'Mäßige Regenschauer',
  82: 'Starke Regenschauer',
  85: 'Leichte Schneeschauer',
  86: 'Starke Schneeschauer',
  95: 'Gewitter ⛈️',
  96: 'Gewitter mit Hagel (leicht)',
  99: 'Gewitter mit Hagel (stark)'
};

function getWeatherDescription(code) {
  return WEATHER_CODES[code] || `Wettercode ${code}`;
}

async function fetchWeather(args) {
  const { latitude, longitude, forecast_days = 7 } = args;
  
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m',
    hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,wind_speed_10m_max',
    timezone: 'Europe/Berlin',
    forecast_days: forecast_days.toString()
  });

  const response = await fetch(`${BASE_URL}?${params}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo API Error: ${response.status}`);
  }
  return await response.json();
}

const definitions = [
  {
    name: 'openmeteo_current',
    description: 'Holt das aktuelle Wetter für einen Standort. Braucht latitude und longitude (z.B. 51.5 für Witten).',
    input_schema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Breitengrad (z.B. 51.5 für Witten)' },
        longitude: { type: 'number', description: 'Längengrad (z.B. 7.35 für Witten)' }
      },
      required: ['latitude', 'longitude']
    }
  },
  {
    name: 'openmeteo_forecast',
    description: 'Holt die Wettervorhersage für mehrere Tage. Braucht latitude und longitude.',
    input_schema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Breitengrad (z.B. 51.5 für Witten)' },
        longitude: { type: 'number', description: 'Längengrad (z.B. 7.35 für Witten)' },
        days: { type: 'number', description: 'Anzahl Tage (1-16, Standard: 7)' }
      },
      required: ['latitude', 'longitude']
    }
  },
  {
    name: 'openmeteo_hourly',
    description: 'Holt die stündliche Vorhersage für heute und morgen. Braucht latitude und longitude.',
    input_schema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Breitengrad' },
        longitude: { type: 'number', description: 'Längengrad' }
      },
      required: ['latitude', 'longitude']
    }
  }
];

async function execute(name, input) {
  const { latitude, longitude, days = 7 } = input;

  switch (name) {
    case 'openmeteo_current': {
      const data = await fetchWeather({ latitude, longitude, forecast_days: 1 });
      const c = data.current;
      
      return {
        status: 'Aktuelles Wetter',
        location: `${latitude}, ${longitude}`,
        temperature: `${c.temperature_2m}°C`,
        feels_like: `${c.apparent_temperature}°C`,
        humidity: `${c.relative_humidity_2m}%`,
        wind: `${c.wind_speed_10m} km/h`,
        clouds: `${c.cloud_cover}%`,
        precipitation: `${c.precipitation} mm`,
        condition: getWeatherDescription(c.weather_code)
      };
    }

    case 'openmeteo_forecast': {
      const data = await fetchWeather({ latitude, longitude, forecast_days: days });
      const daily = data.daily;
      
      const forecasts = daily.time.map((date, i) => ({
        date,
        day: new Date(date).toLocaleDateString('de-DE', { weekday: 'short' }),
        condition: getWeatherDescription(daily.weather_code[i]),
        temp_max: `${daily.temperature_2m_max[i]}°C`,
        temp_min: `${daily.temperature_2m_min[i]}°C`,
        feels_max: `${daily.apparent_temperature_max[i]}°C`,
        feels_min: `${daily.apparent_temperature_min[i]}°C`,
        precipitation_sum: `${daily.precipitation_sum[i]} mm`,
        precipitation_prob: `${daily.precipitation_probability_max[i]}%`,
        wind_max: `${daily.wind_speed_10m_max[i]} km/h`,
        sunrise: daily.sunrise[i].split('T')[1],
        sunset: daily.sunset[i].split('T')[1]
      }));

      return {
        status: `Wettervorhersage (${days} Tage)`,
        location: `${latitude}, ${longitude}`,
        forecasts
      };
    }

    case 'openmeteo_hourly': {
      const data = await fetchWeather({ latitude, longitude, forecast_days: 2 });
      const hourly = data.hourly;
      
      // Nächste 24 Stunden
      const now = new Date();
      const next24h = [];
      
      for (let i = 0; i < 24 && i < hourly.time.length; i++) {
        const time = new Date(hourly.time[i]);
        next24h.push({
          time: time.toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit' }),
          temp: `${hourly.temperature_2m[i]}°C`,
          humidity: `${hourly.relative_humidity_2m[i]}%`,
          precip_prob: `${hourly.precipitation_probability[i]}%`,
          precipitation: `${hourly.precipitation[i]} mm`,
          condition: getWeatherDescription(hourly.weather_code[i])
        });
      }

      return {
        status: 'Stündliche Vorhersage (24h)',
        location: `${latitude}, ${longitude}`,
        hourly: next24h
      };
    }

    default:
      throw new Error(`Unknown function: ${name}`);
  }
}

module.exports = { definitions, execute };
