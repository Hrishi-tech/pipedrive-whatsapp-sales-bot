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

async function fetchWonDealsToday(crm) {
  if (!crm.token || !crm.domain) return [];

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

  // Get current date in London timezone (YYYY-MM-DD)
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });

  return (response.data.data || []).filter(
    (deal) => deal.won_time && deal.won_time.startsWith(today)
  );
}

function calculateSalesByOwner(deals) {
  const stats = {};
  deals.forEach((deal) => {
    const owner = deal.owner_name || "Unknown";
    const value = Number(deal.value || 0);

    if (!stats[owner]) {
      stats[owner] = { count: 0, value: 0 };
    }
    stats[owner].count++;
    stats[owner].value += value;
  });
  return stats;
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

function buildWhatsAppSummary(salesStats, hardwareSalesBreakdown) {
  const dateStr = new Date().toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  let msg = `🚀 *TFS DAILY SALES UPDATE*\n`;
  msg += `📅 *${dateStr}* | 🕒 17:00\n\n`;
  msg += `━━━━━━━━━━━━━━━━━\n`;
  msg += `🏆 *END OF DAY SALES FIGURES*\n`;
  msg += `━━━━━━━━━━━━━━━━━\n\n`;

  msg += `💷 *Total Sales:* £${salesStats.total}k (${salesStats.count} deals)\n`;
  msg += `  └ 🚪 *Gate:* £${salesStats.gate}k (${salesStats.gateCount})\n`;
  msg += `  └ 🛠 *Hardware Total:* £${salesStats.hardware}k (${salesStats.hardwareCount})\n`;
  msg += `      • Hardware Deals: £${hardwareSalesBreakdown.hardware.value}k (${hardwareSalesBreakdown.hardware.count})\n`;
  msg += `      • Web Sales: £${hardwareSalesBreakdown.web.value}k (${hardwareSalesBreakdown.web.count})\n\n`;

  msg += `👤 *Individual Sales Breakdown*\n`;
  const sortedUsers = Object.entries(salesStats.users).sort(
    (a, b) => b[1].value - a[1].value
  );

  if (sortedUsers.length === 0) {
    msg += `_No won sales recorded today._\n`;
  } else {
    sortedUsers.forEach(([name, data]) => {
      msg += `• *${name}:* £${(data.value / 1000).toFixed(2)}k (${data.count})\n`;
    });
  }

  return msg;
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
    const [hardwareWon, gateWon] = await Promise.all([
      fetchWonDealsToday(HARDWARE),
      fetchWonDealsToday(GATE),
    ]);

    const allWon = [...hardwareWon, ...gateWon];
    const salesStats = {
      total: calculateSalesValue(allWon),
      count: allWon.length,
      gate: calculateSalesValue(gateWon),
      gateCount: gateWon.length,
      hardware: calculateSalesValue(hardwareWon),
      hardwareCount: hardwareWon.length,
      users: calculateSalesByOwner(allWon),
    };

    const hardwareBreakdown = calculateHardwareSalesBreakdown(hardwareWon);
    const summaryMsg = buildWhatsAppSummary(salesStats, hardwareBreakdown);

    console.log("\nGenerated WhatsApp Payload:\n", summaryMsg);
    await sendToWhatsAppGroup(summaryMsg);
  } catch (err) {
    console.error("Execution failed:", err.message);
    process.exit(1);
  }
}

main();