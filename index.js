// index.js
require("dotenv").config();
const axios = require("axios");
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

// Helper to format numbers into UK currency strings (e.g., 19920 -> "19,920.00")
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
${dateStr} | 16:55
\`\`\`
DAILY IN ───── £${dailyStats.total}
  ├─ Gates     £${dailyStats.gate}
  └─ Hardware  £${dailyStats.hardware}
     ├─ Deals  £${dailyHardwareBreakdown.hardware.value}
     └─ Web    £${dailyHardwareBreakdown.web.value}

MONTHLY IN ─── £${monthlyStats.total}
  ├─ Gates     £${monthlyStats.gate}
  └─ Hardware  £${monthlyStats.hardware}\`\`\``;
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
    console.log("Fetching Pipedrive sales data...");
    const [hardwareDeals, gateDeals] = await Promise.all([
      fetchWonDeals(HARDWARE),
      fetchWonDeals(GATE),
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

    const summaryMsg = buildWhatsAppSummary(dailyStats, dailyHardwareBreakdown, monthlyStats);

    console.log("\nGenerated WhatsApp Payload:\n", summaryMsg);
    await sendToWhatsAppGroup(summaryMsg);
  } catch (err) {
    console.error("Execution failed:", err.message);
    process.exit(1);
  }
}

main();
