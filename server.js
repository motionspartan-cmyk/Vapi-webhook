onst express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// ─── Parse the call into sales fields ─────────────────────────────────────────
function parseSalesData(payload) {
  const { message } = payload;
  if (!message || message.type !== "end-of-call-report") return null;

  const call        = message.call || {};
  const analysis    = message.analysis || {};
  const structured  = analysis.structuredData || {};

  const date = call.startedAt
    ? new Date(call.startedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })
    : new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });

  const caller = call.customer?.number || call.phoneNumber?.number || "Unknown";

  const durationSecs =
    call.startedAt && call.endedAt
      ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
      : 0;
  const duration = durationSecs
    ? `${Math.floor(durationSecs / 60)}m ${durationSecs % 60}s`
    : "Unknown";

  // Pull sales outcome — Vapi puts these in structuredData if your assistant
  // is configured to extract them, otherwise falls back to summary analysis
  const agreed = structured.agreed
    ?? structured.deal_agreed
    ?? structured.customer_agreed
    ?? (analysis.successEvaluation === "true" || analysis.successEvaluation === true
        ? "Yes" : analysis.successEvaluation === "false" || analysis.successEvaluation === false
        ? "No" : "Unknown");

  const price = structured.price
    ?? structured.agreed_price
    ?? structured.deal_value
    ?? structured.amount
    ?? "Not mentioned";

  const goodSell = structured.good_sell
    ?? structured.quality
    ?? null;

  // Derive "good sell" from success evaluation if not explicitly extracted
  const successEval = analysis.successEvaluation;
  const goodSellLabel = goodSell
    ?? (successEval === "true" || successEval === true ? "Yes"
      : successEval === "false" || successEval === false ? "No"
      : "Review needed");

  const summary = analysis.summary || message.summary || "No summary";
  const callId  = call.id || "N/A";

  return [date, caller, duration, goodSellLabel, agreed, price, summary, callId];
}

// ─── Append a row to Google Sheets ────────────────────────────────────────────
async function appendToSheet(row) {
  const auth   = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetId = process.env.GOOGLE_SHEET_ID;

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Sheet1!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// ─── Webhook ───────────────────────────────────────────────────────────────────
app.post("/vapi-webhook", async (req, res) => {
  try {
    const type = req.body?.message?.type;
    console.log(`[Vapi] Event: ${type}`);

    if (type !== "end-of-call-report") {
      return res.json({ received: true, logged: false });
    }

    const row = parseSalesData(req.body);
    if (!row) return res.status(400).json({ error: "Could not parse payload" });

    await appendToSheet(row);
    console.log(`[Vapi] ✅ Logged: ${row[1]} | Agreed: ${row[4]} | Price: ${row[5]}`);
    res.json({ received: true, logged: true });
  } catch (err) {
    console.error("[Vapi] ❌", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) =>
  res.json({ status: "Vapi Sales Webhook live 🟢" })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
