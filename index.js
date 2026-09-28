// =============================================================
// TFS DAILY SALES UPDATE
// =============================================================

require("dotenv").config();

const axios = require("axios");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");

// =============================================================
// CONFIGURATION
// =============================================================

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

const PIPEDRIVE_PAGE_SIZE = 500;
const PIPEDRIVE_TIMEOUT = 30000;

// =============================================================
// DATE HELPERS
// =============================================================

function getLondonDate() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });
}

function getLondonMonth() {
  return getLondonDate().slice(0, 7);
}

// Convert a Pipedrive won_time into a London YYYY-MM-DD date.
//
// Pipedrive timestamps can contain either:
//   2026-09-28 16:30:00
// or:
//   2026-09-28T16:30:00Z
//
// If there is no timezone indicator, Pipedrive's datetime is treated
// as UTC before converting to London time.
function getLondonDateFromPipedrive(wonTime) {
  if (!wonTime) return null;

  let dateString = wonTime;

  // Pipedrive commonly returns "YYYY-MM-DD HH:mm:ss"
  if (
    !dateString.includes("T") &&
    !dateString.endsWith("Z") &&
    !/[+-]\d{2}:\d{2}$/.test(dateString)
  ) {
    dateString = dateString.replace(" ", "T") + "Z";
  }

  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });
}

// =============================================================
// PIPEDRIVE
// =============================================================

/**
 * Fetch won deals for:
 *   - Today
 *   - Current month
 *
 * Pagination is used so we don't have the old 500-deal limitation.
 *
 * Because results are sorted newest -> oldest, pagination stops as soon
 * as we reach deals from before the current month.
 */
async function fetchWonDeals(crm) {
  if (!crm.token || !crm.domain) {
    console.warn(`Missing Pipedrive credentials for ${crm.domain || "CRM"}`);
    return {
      today: [],
      month: [],
    };
  }

  const todayStr = getLondonDate();
  const monthStr = todayStr.slice(0, 7);

  const monthDeals = [];
  let start = 0;
  let pageNumber = 0;

  try {
    while (true) {
      pageNumber++;

      const response = await axios.get(
        `https://${crm.domain}.pipedrive.com/api/v1/deals`,
        {
          params: {
            api_token: crm.token,
            status: "won",
            limit: PIPEDRIVE_PAGE_SIZE,
            start,
            sort: "won_time DESC",
          },

          timeout: PIPEDRIVE_TIMEOUT,
        }
      );

      const deals = response.data?.data || [];

      if (deals.length === 0) {
        break;
      }

      console.log(
        `${crm.domain}: page ${pageNumber} → ${deals.length} deals`
      );

      let reachedPreviousMonth = false;

      for (const deal of deals) {
        if (!deal.won_time) {
          continue;
        }

        const londonDate = getLondonDateFromPipedrive(deal.won_time);

        if (!londonDate) {
          continue;
        }

        const dealMonth = londonDate.slice(0, 7);

        // Because Pipedrive returns newest → oldest,
        // once we hit a previous month we can stop fetching.
        if (dealMonth < monthStr) {
          reachedPreviousMonth = true;
          break;
        }

        // Only keep current-month deals.
        if (dealMonth === monthStr) {
          monthDeals.push(deal);
        }
      }

      // Stop if we have reached deals before the current month.
      if (reachedPreviousMonth) {
        break;
      }

      // Check whether Pipedrive has another page.
      const pagination =
        response.data?.additional_data?.pagination;

      if (!pagination?.more_items_in_collection) {
        break;
      }

      start = pagination.next_start;
    }

    const todayDeals = monthDeals.filter((deal) => {
      const londonDate = getLondonDateFromPipedrive(deal.won_time);
      return londonDate === todayStr;
    });

    console.log(
      `${crm.domain}: ${monthDeals.length} current-month deals found`
    );

    console.log(
      `${crm.domain}: ${todayDeals.length} today's deals found`
    );

    return {
      today: todayDeals,
      month: monthDeals,
    };
  } catch (error) {
    console.error(
      `Failed to fetch deals from ${crm.domain}:`,
      error.response?.data || error.message
    );

    throw error;
  }
}

// =============================================================
// NUMBER / CURRENCY HELPERS
// =============================================================

function formatCurrency(amount) {
  return Number(amount || 0).toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function getSalesValue(deals) {
  return deals.reduce(
    (total, deal) => total + Number(deal.value || 0),
    0
  );
}

function calculateSalesValue(deals) {
  return formatCurrency(getSalesValue(deals));
}

// =============================================================
// HARDWARE BREAKDOWN
// =============================================================

function calculateHardwareSalesBreakdown(deals) {
  const breakdown = {
    hardwareValue: 0,
    hardwareCount: 0,
    webValue: 0,
    webCount: 0,
  };

  for (const deal of deals) {
    const value = Number(deal.value || 0);

    if (
      Number(deal.pipeline_id) ===
      HARDWARE_PIPELINES.HARDWARE_DEALS
    ) {
      breakdown.hardwareValue += value;
      breakdown.hardwareCount++;
    } else if (
      Number(deal.pipeline_id) ===
      HARDWARE_PIPELINES.WEB_SALES
    ) {
      breakdown.webValue += value;
      breakdown.webCount++;
    }
  }

  return {
    hardware: {
      value: formatCurrency(breakdown.hardwareValue),
      count: breakdown.hardwareCount,
    },

    web: {
      value: formatCurrency(breakdown.webValue),
      count: breakdown.webCount,
    },
  };
}

// =============================================================
// STATS
// =============================================================

function calculateStats(deals) {
  return {
    total: calculateSalesValue(deals),
    count: deals.length,
  };
}

function calculateCombinedStats(gateDeals, hardwareDeals) {
  return {
    total: calculateSalesValue([
      ...gateDeals,
      ...hardwareDeals,
    ]),

    count: gateDeals.length + hardwareDeals.length,

    gate: calculateSalesValue(gateDeals),
    gateCount: gateDeals.length,

    hardware: calculateSalesValue(hardwareDeals),
    hardwareCount: hardwareDeals.length,
  };
}

// =============================================================
// WHATSAPP MESSAGE
// =============================================================

function buildWhatsAppSummary(
  dailyStats,
  dailyHardwareBreakdown,
  monthlyStats
) {
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

// =============================================================
// WHATSAPP
// =============================================================

async function sendToWhatsAppGroup(messageText) {
  const { state, saveCreds } =
    await useMultiFileAuthState("auth_info");

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
    let messageSent = false;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        if (messageSent) return;

        messageSent = true;

        const groupId = process.env.WHATSAPP_GROUP_ID;

        if (!groupId) {
          reject(
            new Error("WHATSAPP_GROUP_ID is missing from .env")
          );
          return;
        }

        try {
          console.log(
            `Connected to WhatsApp. Dispatching update to group: ${groupId}`
          );

          await sock.sendMessage(groupId, {
            text: messageText,
          });

          console.log("✅ Message dispatched successfully.");

          // Give Baileys a moment to finish sending before exiting.
          setTimeout(() => {
            resolve();
            process.exit(0);
          }, 3000);
        } catch (error) {
          reject(error);
        }
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log(
          `WhatsApp connection closed (Status Code: ${
            statusCode || "unknown"
          }).`
        );

        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === 401 ||
          statusCode === 403
        ) {
          reject(
            new Error(
              "WhatsApp session invalid. Re-authenticate locally."
            )
          );
        } else if (!messageSent) {
          reject(
            new Error(
              "WhatsApp connection closed before the message was sent."
            )
          );
        }
      }
    });
  });
}

// =============================================================
// MAIN
// =============================================================

async function main() {
  try {
    console.log("========================================");
    console.log("TFS DAILY SALES UPDATE");
    console.log("========================================");

    console.log("Fetching Pipedrive sales data...");

    // Fetch both CRMs at the same time.
    const [hardwareDeals, gateDeals] = await Promise.all([
      fetchWonDeals(HARDWARE),
      fetchWonDeals(GATE),
    ]);

    // ---------------------------------------------------------
    // DAILY
    // ---------------------------------------------------------

    const dailyStats = calculateCombinedStats(
      gateDeals.today,
      hardwareDeals.today
    );

    const dailyHardwareBreakdown =
      calculateHardwareSalesBreakdown(
        hardwareDeals.today
      );

    // ---------------------------------------------------------
    // MONTHLY
    // ---------------------------------------------------------

    const monthlyStats = calculateCombinedStats(
      gateDeals.month,
      hardwareDeals.month
    );

    // ---------------------------------------------------------
    // LOG RESULTS
    // ---------------------------------------------------------

    console.log("\n----------------------------------------");
    console.log("DAILY");
    console.log("----------------------------------------");

    console.log(`Total:    £${dailyStats.total}`);
    console.log(`Gates:    £${dailyStats.gate}`);
    console.log(`Hardware: £${dailyStats.hardware}`);

    console.log("\nHardware breakdown:");
    console.log(
      `Deals: £${dailyHardwareBreakdown.hardware.value}`
    );
    console.log(
      `Web:   £${dailyHardwareBreakdown.web.value}`
    );

    console.log("\n----------------------------------------");
    console.log("MONTHLY");
    console.log("----------------------------------------");

    console.log(`Total:    £${monthlyStats.total}`);
    console.log(`Gates:    £${monthlyStats.gate}`);
    console.log(`Hardware: £${monthlyStats.hardware}`);

    console.log("----------------------------------------");

    // ---------------------------------------------------------
    // BUILD MESSAGE
    // ---------------------------------------------------------

    const summaryMsg = buildWhatsAppSummary(
      dailyStats,
      dailyHardwareBreakdown,
      monthlyStats
    );

    console.log("\nGenerated WhatsApp Payload:\n");
    console.log(summaryMsg);

    // ---------------------------------------------------------
    // SEND
    // ---------------------------------------------------------

    await sendToWhatsAppGroup(summaryMsg);
  } catch (error) {
    console.error("\n❌ Execution failed:");

    if (error.response?.data) {
      console.error(error.response.data);
    } else {
      console.error(error.message);
    }

    process.exit(1);
  }
}

<<<<<<< HEAD
// =============================================================
// START
// =============================================================

main();
=======
main();
>>>>>>> 54462cec301d2a3821783ca5e013efcab0d478ce
