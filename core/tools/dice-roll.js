// dice_roll.js — Wirft einen Würfel mit konfigurierbarer Seitenzahl (Standard: 6)

export const definitions = [{
  name: "dice_roll",
  description: "Wirft einen Würfel mit konfigurierbarer Seitenzahl. Standardmäßig ein 6-seitiger Würfel.",
  input_schema: {
    type: "object",
    properties: {
      sides: { type: "integer", description: "Anzahl der Seiten des Würfels", minimum: 2, maximum: 1000, default: 6 }
    },
    required: []
  }
}];

export async function execute(name, input) {
  if (name !== "dice_roll") throw new Error(`unknown: ${name}`);
  const sides = input?.sides || 6;
  if (sides < 2 || sides > 1000) throw new Error("Seitenzahl muss zwischen 2 und 1000 liegen");
  const result = Math.floor(Math.random() * sides) + 1;
  return { ok: true, result, sides, message: `Geworfen: ${result} auf einem ${sides}-seitigen Würfel` };
}