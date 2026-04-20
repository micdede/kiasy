// Rezept-Tool — TheMealDB API (kostenlos, kein Key)
// Englische Rezepte mit Bildern, Zutaten und Anleitung

const MEALDB_API = "https://www.themealdb.com/api/json/v1/1";

const definitions = [
  {
    name: "recipe_random",
    description: "Holt ein zufälliges Rezept. Optional: Kategorie (Seafood, Chicken, Beef, Pasta, Vegetarian, Dessert, Breakfast) oder Küche/Region (Italian, Mexican, Chinese, Japanese, Indian, French, etc.) als Filter.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optionale Kategorie (z.B. Pasta, Vegetarian, Dessert)",
        },
        area: {
          type: "string",
          description: "Optionale Küche/Region (z.B. Italian, Indian, Mexican)",
        },
      },
    },
  },
  {
    name: "recipe_search",
    description: "Sucht Rezepte nach Namen. Liefert bis zu 5 Treffer mit Bild.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchbegriff (z.B. arrabiata, chicken curry)" },
      },
      required: ["query"],
    },
  },
];

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function execute(name, input) {
  try {
    if (name === "recipe_random") {
      let meal;
      if (input.category) {
        const list = await fetchJSON(`${MEALDB_API}/filter.php?c=${encodeURIComponent(input.category)}`);
        if (!list.meals?.length) return `Keine Rezepte in Kategorie "${input.category}" gefunden.`;
        const pick = list.meals[Math.floor(Math.random() * list.meals.length)];
        const detail = await fetchJSON(`${MEALDB_API}/lookup.php?i=${pick.idMeal}`);
        meal = detail.meals?.[0];
      } else if (input.area) {
        const list = await fetchJSON(`${MEALDB_API}/filter.php?a=${encodeURIComponent(input.area)}`);
        if (!list.meals?.length) return `Keine Rezepte aus "${input.area}" gefunden.`;
        const pick = list.meals[Math.floor(Math.random() * list.meals.length)];
        const detail = await fetchJSON(`${MEALDB_API}/lookup.php?i=${pick.idMeal}`);
        meal = detail.meals?.[0];
      } else {
        const data = await fetchJSON(`${MEALDB_API}/random.php`);
        meal = data.meals?.[0];
      }
      if (!meal) return "Kein Rezept gefunden.";
      return formatRecipe(meal);
    }

    if (name === "recipe_search") {
      const data = await fetchJSON(`${MEALDB_API}/search.php?s=${encodeURIComponent(input.query)}`);
      if (!data.meals?.length) return `Keine Rezepte für "${input.query}" gefunden.`;
      const meals = data.meals.slice(0, 5);
      let out = `*Rezepte für "${input.query}":*\n\n`;
      meals.forEach((m, i) => {
        out += `${i + 1}. *${m.strMeal}*\n`;
        out += `   ${m.strArea || "?"} • ${m.strCategory || "?"}\n`;
        if (m.strMealThumb) out += `   ${m.strMealThumb}\n`;
        out += "\n";
      });
      out += `_Frage nach einem Namen für die Details (recipe_search mit dem Namen)._`;
      return out;
    }

    throw new Error(`Unbekannte Funktion: ${name}`);
  } catch (e) {
    return `Rezept-Fehler: ${e.message}`;
  }
}

function formatRecipe(meal) {
  // Zutaten zusammensammeln
  const ingredients = [];
  for (let i = 1; i <= 20; i++) {
    const ing = meal[`strIngredient${i}`];
    const meas = meal[`strMeasure${i}`];
    if (ing && ing.trim()) {
      ingredients.push(`• ${(meas || "").trim()} ${ing.trim()}`.replace(/\s+/g, " ").trim());
    }
  }

  // Anleitung in Schritte zerlegen
  const instructions = (meal.strInstructions || "")
    .split(/\r?\n+/)
    .map(s => s.trim())
    .filter(Boolean);

  let out = `*${meal.strMeal}*\n`;
  out += `${meal.strArea || "?"} • ${meal.strCategory || "?"}`;
  if (meal.strTags) out += ` • ${meal.strTags}`;
  out += `\n\n`;

  if (meal.strMealThumb) out += `${meal.strMealThumb}\n\n`;

  out += `*Zutaten:*\n${ingredients.join("\n")}\n\n`;
  out += `*Zubereitung:*\n${instructions.map((s, i) => `${i + 1}. ${s}`).join("\n\n")}`;

  if (meal.strYoutube) out += `\n\nVideo: ${meal.strYoutube}`;
  if (meal.strSource) out += `\nQuelle: ${meal.strSource}`;

  return out;
}

module.exports = { definitions, execute };
