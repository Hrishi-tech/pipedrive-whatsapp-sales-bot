// authenticate.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");

async function initAuth() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  
  const sock = makeWASocket({
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log("\nScan the QR code below with your WhatsApp linked device:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("\n✅ Successfully authenticated!");
      console.log("Fetching participating group chats...\n");

      const groups = await sock.groupFetchAllParticipating();
      
      console.log("================ YOUR WHATSAPP GROUPS ================");
      Object.values(groups).forEach((group) => {
        console.log(`• Group Name: "${group.subject}"`);
        console.log(`  Group ID:   ${group.id}\n`);
      });
      console.log("======================================================");
      console.log("Copy your target Group ID for your secrets.");
      process.exit(0);
    } else if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      // Code 515 requires a restart right after pairing - automatically reconnect
      if (shouldReconnect) {
        console.log("Connection updating (standard after QR scan). Reconnecting...");
        initAuth();
      } else {
        console.log("Session logged out. Delete 'auth_info' folder and scan again.");
      }
    }
  });
}

initAuth();