// authenticate.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

async function initAuth() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log("\nScan the QR code below:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("\n✅ Successfully authenticated!");
      console.log("Session files successfully saved in auth_info/\n");
      
      const groups = await sock.groupFetchAllParticipating();
      console.log("================ WHATSAPP GROUPS ================");
      Object.values(groups).forEach((group) => {
        console.log(`• ${group.subject}: ${group.id}`);
      });
      console.log("=================================================\n");
      
      setTimeout(() => process.exit(0), 2000);

    } else if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;

      if (shouldReconnect) {
        console.log("Reconnecting stream...");
        initAuth();
      } else {
        console.log("Session invalid or logged out. Resetting auth_info folder...");
        fs.rmSync("auth_info", { recursive: true, force: true });
        console.log("Run 'node authenticate.js' again to generate a new QR code.");
        process.exit(1);
      }
    }
  });
}

initAuth();