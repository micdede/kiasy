// Shared Kerio Connect Konfiguration
// Liest Zugangsdaten aus .env

function getKerioConfig() {
  const host = process.env.KERIO_HOST;
  const user = process.env.KERIO_USER;
  const password = process.env.KERIO_PASSWORD;

  if (!host || !user || !password) {
    throw new Error(
      "Kerio-Konfiguration unvollständig. Benötigt: KERIO_HOST, KERIO_USER, KERIO_PASSWORD in .env"
    );
  }

  return {
    host,
    user,
    password,
    from: process.env.KERIO_FROM || user,
    imapPort: 993,
    smtpPort: 587,
  };
}

module.exports = { getKerioConfig };
