// index.js
require("dotenv").config();
const axios = require("axios");
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

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

// Fetches won deals for both Today and Current Month
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

  // Get current date and month in London timezone
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

function calculateSalesValue(deals) {
  let total = deals.reduce((acc, deal) => acc + Number(deal.value || 0), 0);
  return (total / 1000).toFixed(2);
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
    hardware: { value: (hardwareValue / 1000).toFixed(2), count: hardwareCount },
    web: { value: (webValue / 1000).toFixed(2), count: webCount },
  };
}

// -------------------------------------------------------------
// WHERE THE MESSAGE IS FORMATTED
// -------------------------------------------------------------
function buildWhatsAppSummary(dailyStats, dailyHardwareBreakdown, monthlyStats) {
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
DAILY IN ────── £${dailyStats.total}k
  ├─ Gates      £${dailyStats.gate}k
  └─ Hardware   £${dailyStats.hardware}k
     ├─ Deals   £${dailyHardwareBreakdown.hardware.value}k
     └─ Web     £${dailyHardwareBreakdown.web.value}k

MONTHLY IN ──── £${monthlyStats.total}k
  ├─ Gates      £${monthlyStats.gate}k
  └─ Hardware   £${monthlyStats.hardware}k\`\`\``;
}

async function sendToWhatsAppGroup(messageText) {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
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
        if (statusCode === 401) {
          reject(new Error("WhatsApp session invalid. Re-authenticate locally."));
        }
      }
    });
  });
}

async function main() {
  try {
    console.log("Fetching Pipedrive sales data...");
    const [hardwareDeals, gateDeals] = await Promise.all([
      fetchWonDeals(HARDWARE),
      fetchWonDeals(GATE),
    ]);

    // Daily calculations
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

    // Monthly calculations
    const monthlyWon = [...hardwareDeals.month, ...gateDeals.month];
    const monthlyStats = {
      total: calculateSalesValue(monthlyWon),
      count: monthlyWon.length,
      gate: calculateSalesValue(gateDeals.month),
      gateCount: gateDeals.month.length,
      hardware: calculateSalesValue(hardwareDeals.month),
      hardwareCount: hardwareDeals.month.length,
    };

    const summaryMsg = buildWhatsAppSummary(dailyStats, dailyHardwareBreakdown, monthlyStats);

    console.log("\nGenerated WhatsApp Payload:\n", summaryMsg);
    await sendToWhatsAppGroup(summaryMsg);
  } catch (err) {
    console.error("Execution failed:", err.message);
    process.exit(1);
  }
}

main();