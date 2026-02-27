const { DAVClient } = require("tsdav");
const { getKerioConfig } = require("./kerio-config");

const definitions = [
  {
    name: "contacts_search",
    description:
      "Sucht in den Kerio-Kontakten nach einem Kontakt. Gibt Name, E-Mail und Telefonnummer zurück.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Suchbegriff (Name, E-Mail oder Telefonnummer)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "contacts_add",
    description: "Erstellt einen neuen Kontakt in Kerio Connect.",
    input_schema: {
      type: "object",
      properties: {
        firstName: {
          type: "string",
          description: "Vorname",
        },
        lastName: {
          type: "string",
          description: "Nachname (optional)",
        },
        email: {
          type: "string",
          description: "E-Mail-Adresse (optional)",
        },
        phone: {
          type: "string",
          description: "Telefonnummer (optional)",
        },
      },
      required: ["firstName"],
    },
  },
];

async function getDAVClient() {
  const cfg = getKerioConfig();
  const client = new DAVClient({
    serverUrl: `https://${cfg.host}/carddav/`,
    credentials: { username: cfg.user, password: cfg.password },
    authMethod: "Basic",
    defaultAccountType: "carddav",
  });
  await client.login();
  return client;
}

function parseVCard(vcardData) {
  const get = (key) => {
    const match = vcardData.match(new RegExp(`${key}[^:]*:(.+?)\\r?\\n`, "i"));
    return match ? match[1].trim() : null;
  };

  return {
    fn: get("FN"),
    email: get("EMAIL"),
    tel: get("TEL"),
  };
}

async function execute(name, input) {
  try {
    switch (name) {
      case "contacts_search": {
        const client = await getDAVClient();
        const addressBooks = await client.fetchAddressBooks();

        if (addressBooks.length === 0) {
          return "Kein Adressbuch gefunden.";
        }

        const query = input.query.toLowerCase();
        const results = [];

        for (const book of addressBooks) {
          const vcards = await client.fetchVCards({ addressBook: book });

          for (const vc of vcards) {
            if (!vc.data) continue;
            const parsed = parseVCard(vc.data);
            const searchStr = [parsed.fn, parsed.email, parsed.tel]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();

            if (searchStr.includes(query)) {
              results.push(parsed);
            }
          }
        }

        if (results.length === 0) {
          return `Keine Kontakte gefunden für "${input.query}".`;
        }

        const lines = results.map((c) => {
          return `• ${c.fn || "(kein Name)"}\n  📧 ${c.email || "-"} | 📞 ${c.tel || "-"}`;
        });

        return `👥 ${results.length} Kontakt(e) gefunden:\n${lines.join("\n")}`;
      }

      case "contacts_add": {
        const client = await getDAVClient();
        const addressBooks = await client.fetchAddressBooks();

        if (addressBooks.length === 0) {
          return "❌ Kein Adressbuch gefunden.";
        }

        const uid = `jarvis-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const fullName = input.lastName
          ? `${input.firstName} ${input.lastName}`
          : input.firstName;

        let vcard = [
          "BEGIN:VCARD",
          "VERSION:3.0",
          `UID:${uid}`,
          `FN:${fullName}`,
          `N:${input.lastName || ""};${input.firstName};;;`,
        ];

        if (input.email) {
          vcard.push(`EMAIL;TYPE=INTERNET:${input.email}`);
        }
        if (input.phone) {
          vcard.push(`TEL;TYPE=CELL:${input.phone}`);
        }

        vcard.push("END:VCARD");

        await client.createVCard({
          addressBook: addressBooks[0],
          filename: `${uid}.vcf`,
          vCardString: vcard.join("\r\n"),
        });

        return `✅ Kontakt erstellt: ${fullName}`;
      }

      default:
        return "Unbekannte Kontakte-Operation.";
    }
  } catch (error) {
    return `❌ Kontakte-Fehler: ${error.message}`;
  }
}

module.exports = { definitions, execute };
