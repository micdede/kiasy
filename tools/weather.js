const axios = require('axios');

module.exports = {
  definitions: [
    {
      name: 'weather_get',
      description: 'Holt aktuelle Wetterinformationen und Vorhersage für eine Stadt. Nutzt OpenWeatherMap API.',
      input_schema: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'Stadt für die Wetterinformationen'
          },
          days: {
            type: 'number',
            description: 'Anzahl Tage Vorhersage (1-5)',
          }
        },
        required: ['city']
      }
    }
  ],

  execute: async (name, input) => {
    if (name === 'weather_get') {
      const { city, days = 1 } = input;
      
      try {
        // Kostenlose OpenWeatherMap API (ohne API Key für basic info)
        // Alternativ: wttr.in Service
        const response = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
        const data = response.data;
        
        const current = data.current_condition[0];
        const today = data.weather[0];
        
        let result = `🌤️ *Wetter für ${city}*\n\n`;
        result += `*Aktuell:* ${current.temp_C}°C, ${current.weatherDesc[0].value}\n`;
        result += `*Gefühlt:* ${current.FeelsLikeC}°C\n`;
        result += `*Luftfeuchtigkeit:* ${current.humidity}%\n`;
        result += `*Wind:* ${current.windspeedKmph} km/h\n\n`;
        
        result += `*Heute:*\n`;
        result += `🌅 Min: ${today.mintempC}°C | Max: ${today.maxtempC}°C\n`;
        result += `☔ Regen: ${today.totalSnow_cm || 0}mm\n\n`;
        
        if (days > 1 && data.weather.length > 1) {
          result += `*Weitere Tage:*\n`;
          for (let i = 1; i < Math.min(days, data.weather.length); i++) {
            const day = data.weather[i];
            const date = new Date(day.date).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
            result += `${date}: ${day.mintempC}°C - ${day.maxtempC}°C, ${day.hourly[4].weatherDesc[0].value}\n`;
          }
        }
        
        return result;
        
      } catch (error) {
        console.error('Weather API Error:', error.message);
        return `❌ Konnte Wetterdaten für ${city} nicht abrufen. Bitte überprüfe den Städtenamen.`;
      }
    }
    
    throw new Error(`Unbekannte Funktion: ${name}`);
  }
};