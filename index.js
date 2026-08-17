// index.js
require("dotenv").config();
const axios = require("axios");
const puppeteer = require("puppeteer");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");

const HARDWARE = {
  token: process.env.HARDWARE_API_TOKEN,
  domain: process.env.HARDWARE_COMPANY_DOMAIN,
};

const GATE = {
  token: process.env.GATE_API_TOKEN,
  domain: process.env.GATE_COMPANY_DOMAIN,
};

const HARDWARE_PIPELINES = {
  HARDWARE_DEALS: 1,
  WEB_SALES: 12,
};

// -------------------------------------------------------------
// PIPEDRIVE SALES IN FETCHERS
// -------------------------------------------------------------
async function fetchWonDeals(crm) {
  if (!crm.token || !crm.domain) return { today: [], month: [] };

  const response = await axios.get(
    `https://${crm.domain}.pipedrive.com/api/v1/deals`,
    {
      params: {
        api_token: crm.token,
        status: "won",
        limit: 500,
        sort: "won_time DESC",
      },
    }
  );

  const todayStr = new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  }); // "YYYY-MM-DD"
  const monthStr = todayStr.slice(0, 7); // "YYYY-MM"

  const deals = response.data.data || [];
  
  const monthDeals = deals.filter(
    (deal) => deal.won_time && deal.won_time.startsWith(monthStr)
  );
  const todayDeals = monthDeals.filter(
    (deal) => deal.won_time && deal.won_time.startsWith(todayStr)
  );

  return { today: todayDeals, month: monthDeals };
}

function formatCurrency(amount) {
  return Number(amount || 0).toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function calculateSalesValue(deals) {
  let total = deals.reduce((acc, deal) => acc + Number(deal.value || 0), 0);
  return formatCurrency(total);
}

function calculateHardwareSalesBreakdown(deals) {
  let hardwareValue = 0, hardwareCount = 0;
  let webValue = 0, webCount = 0;

  deals.forEach((deal) => {
    const value = Number(deal.value || 0);
    if (deal.pipeline_id === HARDWARE_PIPELINES.HARDWARE_DEALS) {
      hardwareValue += value;
      hardwareCount++;
    } else if (deal.pipeline_id === HARDWARE_PIPELINES.WEB_SALES) {
      webValue += value;
      webCount++;
    }
  });

  return {
    hardware: { value: formatCurrency(hardwareValue), count: hardwareCount },
    web: { value: formatCurrency(webValue), count: webCount },
  };
}

// -------------------------------------------------------------
// PUPPETEER LOOKER STUDIO SCRAPER
// -------------------------------------------------------------
async function fetchLookerSalesOut() {
  let browser;
  try {
    console.log("Launching headless browser to fetch Looker Studio figures...");
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(
      "https://datastudio.google.com/u/0/reporting/8c0d9521-743e-49b1-b402-816fb6f83fc9/page/p_0lwq0wdqmc",
      { waitUntil: "networkidle2", timeout: 60000 }
    );

    // Pause 10s for Looker Studio scorecards to execute data queries
    await new Promise((resolve) => setTimeout(resolve, 10000));

    const salesOutData = await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll("*"));

      // 1. Find vertical Y-coordinates for row labels
      let todayY = null;
      let monthY = null;

      allElements.forEach((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        if (text === "Today:") {
          todayY = el.getBoundingClientRect().top;
        } else if (text === "This Month:") {
          monthY = el.getBoundingClientRect().top;
        }
      });

      // 2. Find all visible currency figures
      const currencyNodes = [];
      allElements.forEach((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        if (/^£[\d,]+(\.\d{2})?$/.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            currencyNodes.push({ text, top: rect.top, left: rect.left });
          }
        }
      });

      // 3. Match row Y-position and select the leftmost figure (Sales OUT)
      function getRowSalesOut(rowY) {
        if (rowY === null) return "N/A";
        const rowMatches = currencyNodes.filter(
          (node) => Math.abs(node.top - rowY) < 40
        );
        rowMatches.sort((a, b) => a.left - b.left);
        return rowMatches.length > 0 ? rowMatches[0].text : "N/A";
      }

      return {
        today: getRowSalesOut(todayY),
        month: getRowSalesOut(monthY),
      };
    });

    console.log("Anchored Extracted Figures:", salesOutData);
    return salesOutData;
  } catch (err) {
    console.error("Looker scraping error:", err.message);
    return { today: "N/A", month: "N/A" };
  } finally {
    if (browser) await browser.close();
  }
}

// -------------------------------------------------------------
// MESSAGE FORMATTING & DISPATCH
// -------------------------------------------------------------
function buildWhatsAppSummary(dailyStats, dailyHardwareBreakdown, monthlyStats, salesOut) {
  const dateStr = new Date().toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return `*🚀 TFS DAILY SALES UPDATE*
${dateStr} | 17:00
\`\`\`
DAILY IN ───── £${dailyStats.total}
  ├─ Gates     £${dailyStats.gate}
  └─ Hardware  £${dailyStats.hardware}
     ├─ Deals  £${dailyHardwareBreakdown.hardware.value}
     └─ Web    £${dailyHardwareBreakdown.web.value}
DAILY OUT ──── ${salesOut.today}

MONTHLY IN ─── £${monthlyStats.total}
  ├─ Gates     £${monthlyStats.gate}
  └─ Hardware  £${monthlyStats.hardware}
MONTHLY OUT ── ${salesOut.month}\`\`\``;
}

async function sendToWhatsAppGroup(messageText) {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on("creds.update", saveCreds);

  return new Promise((resolve, reject) => {
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        const groupId = process.env.WHATSAPP_GROUP_ID;
        console.log(`Connected to WhatsApp. Dispatching update to group: ${groupId}`);
        
        await sock.sendMessage(groupId, { text: messageText });
        console.log("✅ Message dispatched successfully.");

        setTimeout(() => {
          resolve();
          process.exit(0);
        }, 3000);
      } else if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed (Status Code: ${statusCode || "unknown"}).`);

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
          reject(new Error("WhatsApp session invalid. Re-authenticate locally."));
        } else {
          console.log("Transient network drop or stream restart required. Retrying...");
          sendToWhatsAppGroup(messageText).then(resolve).catch(reject);
        }
      }
    });
  });
}

async function main() {
  try {
    console.log("Fetching Pipedrive sales data and Looker OUT figures...");
    const [hardwareDeals, gateDeals, salesOut] = await Promise.all([
      fetchWonDeals(HARDWARE),
      fetchWonDeals(GATE),
      fetchLookerSalesOut(),
    ]);

    const dailyWon = [...hardwareDeals.today, ...gateDeals.today];
    const dailyStats = {
      total: calculateSalesValue(dailyWon),
      count: dailyWon.length,
      gate: calculateSalesValue(gateDeals.today),
      gateCount: gateDeals.today.length,
      hardware: calculateSalesValue(hardwareDeals.today),
      hardwareCount: hardwareDeals.today.length,
    };
    const dailyHardwareBreakdown = calculateHardwareSalesBreakdown(hardwareDeals.today);

    const monthlyWon = [...hardwareDeals.month, ...gateDeals.month];
    const monthlyStats = {
      total: calculateSalesValue(monthlyWon),
      count: monthlyWon.length,
      gate: calculateSalesValue(gateDeals.month),
      gateCount: gateDeals.month.length,
      hardware: calculateSalesValue(hardwareDeals.month),
      hardwareCount: hardwareDeals.month.length,
    };

    const summaryMsg = buildWhatsAppSummary(dailyStats, dailyHardwareBreakdown, monthlyStats, salesOut);

    console.log("\nGenerated WhatsApp Payload:\n", summaryMsg);
    await sendToWhatsAppGroup(summaryMsg);
  } catch (err) {
    console.error("Execution failed:", err.message);
    process.exit(1);
  }
}

main();