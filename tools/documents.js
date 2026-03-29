// Dokument-Erstellung: PDF, Word (DOCX), Excel (XLSX)
const fs = require("fs");
const path = require("path");

const TEMP_DIR = path.join(__dirname, "..", "temp");
const ALLOWED_BASE = process.env.HOME || require("os").homedir();

const definitions = [
  {
    name: "doc_create_pdf",
    description:
      "Erstellt ein PDF-Dokument. Perfekt für Berichte, Protokolle, Zusammenfassungen, Briefe. " +
      "Unterstützt Titel, Abschnitte mit Überschriften, Text, Listen und Tabellen.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Dateiname ohne Endung (z.B. 'bericht')" },
        title: { type: "string", description: "Dokumenttitel" },
        content: {
          type: "array",
          description: "Inhalt als Array von Blöcken",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "text", "list", "table"], description: "Block-Typ" },
              text: { type: "string", description: "Text (für heading, text)" },
              items: { type: "array", items: { type: "string" }, description: "Einträge (für list)" },
              headers: { type: "array", items: { type: "string" }, description: "Spaltenüberschriften (für table)" },
              rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Tabellenzeilen (für table)" },
            },
          },
        },
        footer: { type: "string", description: "Optionale Fußzeile" },
      },
      required: ["filename", "title", "content"],
    },
  },
  {
    name: "doc_create_word",
    description:
      "Erstellt ein Word-Dokument (.docx). Für formatierte Dokumente mit Überschriften, Text, Listen und Tabellen.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Dateiname ohne Endung" },
        title: { type: "string", description: "Dokumenttitel" },
        content: {
          type: "array",
          description: "Inhalt als Array von Blöcken (type: heading, text, list, table)",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "text", "list", "table"] },
              text: { type: "string" },
              items: { type: "array", items: { type: "string" } },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
            },
          },
        },
      },
      required: ["filename", "title", "content"],
    },
  },
  {
    name: "doc_create_excel",
    description:
      "Erstellt eine Excel-Datei (.xlsx). Für Tabellen, Listen, Datenexporte. " +
      "Unterstützt mehrere Arbeitsblätter mit Überschriften und Datenzeilen.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Dateiname ohne Endung" },
        sheets: {
          type: "array",
          description: "Arbeitsblätter",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Name des Arbeitsblatts" },
              headers: { type: "array", items: { type: "string" }, description: "Spaltenüberschriften" },
              rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Datenzeilen" },
            },
            required: ["name", "headers", "rows"],
          },
        },
      },
      required: ["filename", "sheets"],
    },
  },
];

// --- PDF erstellen ---

async function createPDF(input) {
  const PDFDocument = require("pdfkit");
  const filePath = path.join(TEMP_DIR, input.filename + ".pdf");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Titel
    doc.fontSize(22).font("Helvetica-Bold").text(input.title, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(9).font("Helvetica").fillColor("#888")
      .text(new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric", timeZone: process.env.TZ || "Europe/Berlin" }), { align: "center" });
    doc.moveDown(1);
    doc.fillColor("#000");

    // Content-Blöcke
    for (const block of input.content) {
      switch (block.type) {
        case "heading":
          doc.moveDown(0.5);
          doc.fontSize(14).font("Helvetica-Bold").text(block.text);
          doc.moveDown(0.3);
          break;

        case "text":
          doc.fontSize(11).font("Helvetica").text(block.text, { lineGap: 3 });
          doc.moveDown(0.5);
          break;

        case "list":
          if (block.items) {
            for (const item of block.items) {
              doc.fontSize(11).font("Helvetica").text("  •  " + item, { indent: 10, lineGap: 2 });
            }
            doc.moveDown(0.5);
          }
          break;

        case "table":
          if (block.headers && block.rows) {
            const colCount = block.headers.length;
            const tableWidth = 495;
            const colWidth = tableWidth / colCount;
            const startX = doc.x;
            let y = doc.y;

            // Header
            doc.fontSize(10).font("Helvetica-Bold");
            for (let i = 0; i < colCount; i++) {
              doc.rect(startX + i * colWidth, y, colWidth, 20).fill("#e0e0e0").stroke("#ccc");
              doc.fillColor("#000").text(block.headers[i], startX + i * colWidth + 4, y + 5, { width: colWidth - 8, height: 15 });
            }
            y += 20;

            // Rows
            doc.font("Helvetica").fontSize(10);
            for (const row of block.rows) {
              const rowHeight = 18;
              if (y + rowHeight > 780) { doc.addPage(); y = 50; }
              for (let i = 0; i < colCount; i++) {
                doc.rect(startX + i * colWidth, y, colWidth, rowHeight).stroke("#ddd");
                doc.fillColor("#000").text(row[i] || "", startX + i * colWidth + 4, y + 4, { width: colWidth - 8, height: rowHeight - 4 });
              }
              y += rowHeight;
            }
            doc.y = y;
            doc.moveDown(0.5);
          }
          break;
      }
    }

    // Footer
    if (input.footer) {
      doc.moveDown(1);
      doc.fontSize(8).font("Helvetica").fillColor("#888").text(input.footer, { align: "center" });
    }

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

// --- Word erstellen ---

async function createWord(input) {
  const docx = require("docx");
  const filePath = path.join(TEMP_DIR, input.filename + ".docx");

  const children = [];

  // Titel
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: input.title, bold: true, size: 36 })],
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 200 },
  }));

  // Datum
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({
      text: new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric", timeZone: process.env.TZ || "Europe/Berlin" }),
      size: 18, color: "888888",
    })],
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 400 },
  }));

  // Content
  for (const block of input.content) {
    switch (block.type) {
      case "heading":
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: block.text, bold: true, size: 28 })],
          spacing: { before: 300, after: 100 },
        }));
        break;

      case "text":
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: block.text, size: 22 })],
          spacing: { after: 150 },
        }));
        break;

      case "list":
        if (block.items) {
          for (const item of block.items) {
            children.push(new docx.Paragraph({
              children: [new docx.TextRun({ text: item, size: 22 })],
              bullet: { level: 0 },
              spacing: { after: 50 },
            }));
          }
        }
        break;

      case "table":
        if (block.headers && block.rows) {
          const tableRows = [];
          // Header row
          tableRows.push(new docx.TableRow({
            children: block.headers.map(h => new docx.TableCell({
              children: [new docx.Paragraph({ children: [new docx.TextRun({ text: h, bold: true, size: 20 })] })],
              shading: { fill: "E0E0E0" },
            })),
          }));
          // Data rows
          for (const row of block.rows) {
            tableRows.push(new docx.TableRow({
              children: row.map(cell => new docx.TableCell({
                children: [new docx.Paragraph({ children: [new docx.TextRun({ text: cell || "", size: 20 })] })],
              })),
            }));
          }
          children.push(new docx.Table({
            rows: tableRows,
            width: { size: 100, type: docx.WidthType.PERCENTAGE },
          }));
        }
        break;
    }
  }

  const doc = new docx.Document({
    sections: [{ children }],
  });

  const buffer = await docx.Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// --- Excel erstellen ---

async function createExcel(input) {
  const ExcelJS = require("exceljs");
  const filePath = path.join(TEMP_DIR, input.filename + ".xlsx");

  const workbook = new ExcelJS.Workbook();
  workbook.creator = process.env.BOT_NAME || "KIASY";
  workbook.created = new Date();

  for (const sheet of input.sheets) {
    const ws = workbook.addWorksheet(sheet.name);

    // Headers
    ws.columns = sheet.headers.map((h, i) => ({
      header: h,
      key: "col" + i,
      width: Math.max(h.length + 5, 15),
    }));

    // Header-Styling
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
      cell.border = {
        top: { style: "thin" }, bottom: { style: "thin" },
        left: { style: "thin" }, right: { style: "thin" },
      };
    });

    // Datenzeilen
    for (const row of sheet.rows) {
      const dataRow = {};
      row.forEach((val, i) => dataRow["col" + i] = val);
      ws.addRow(dataRow);
    }

    // Auto-Breite anpassen
    ws.columns.forEach(col => {
      let maxLen = col.header ? col.header.length : 10;
      col.eachCell({ includeEmpty: false }, cell => {
        const len = cell.value ? String(cell.value).length : 0;
        if (len > maxLen) maxLen = len;
      });
      col.width = Math.min(maxLen + 3, 50);
    });
  }

  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

// --- Ausführung ---

// Queue für Dateien die an den Nutzer gesendet werden
let fileQueue = [];
function getQueue() { const q = [...fileQueue]; fileQueue = []; return q; }

async function execute(name, input) {
  try {
    let filePath;

    switch (name) {
      case "doc_create_pdf":
        filePath = await createPDF(input);
        break;
      case "doc_create_word":
        filePath = await createWord(input);
        break;
      case "doc_create_excel":
        filePath = await createExcel(input);
        break;
      default:
        return "Unbekannte Dokument-Operation.";
    }

    // Datei in die Queue zum Senden
    fileQueue.push({ path: filePath, caption: input.title || input.filename });

    const ext = path.extname(filePath);
    const size = (fs.statSync(filePath).size / 1024).toFixed(1);
    return `✅ Dokument erstellt: ${path.basename(filePath)} (${size} KB)\nDatei wird gesendet...`;
  } catch (error) {
    return `❌ Dokument-Fehler: ${error.message}`;
  }
}

module.exports = { definitions, execute, getQueue };
