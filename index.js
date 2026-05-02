const { Telegraf } = require("telegraf");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  delay,
  Browsers,
  fetchLatestBaileysVersion,
  generateMessageID,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

// --- MUTE LIBSIGNAL SPAM LOG ---
const originalConsoleInfo = console.info;
console.info = function (...args) {
  if (typeof args[0] === "string" && args[0] === "Closing session:") return;
  originalConsoleInfo.apply(console, args);
};

// --- KONFIGURASI ---
const BOT_TOKEN = " ";
const TARGET_NUMBER = "628111599388"; // Nomor tujuan
const DELAY_ANTAR_KODE = 7000;
const DELAY_RESPON_BOT = 5000;
const MAX_SESSIONS = 50;
const PESAN_PEMBUKA_LIST = [
  "Permisi, saya mau masukkan kode unik nih",
  "Halo, boleh saya masukkan kode unik?",
  "Selamat siang, mau coba masukkan kode promo dong",
  "Halo min, mau input kode unik bisa ya?",
  "Permisi, gimana cara masukkan kode uniknya ya?",
  "Hai, saya mau redeem kode unik dong",
  "Halo, minta bantuan untuk masukkan kode unik ya",
];

const TEKS_STORY_LIST = [
  "Lagi santai nih, ada yang mau japri?",
  "Tetap semangat hari ini!",
  "Mendung-mendung gini enaknya ngapain ya?",
  "Gajian masih lama, tapi semangat tetep jalan kenceng!",
  "Fokus aja dulu, hasilnya biar waktu yang jawab.",
  "Ada yang lagi online? Mabar yuk!",
  "Jangan lupa ngopi biar gak panik ☕",
];
const DELAY_TUNGGU_AQUA = 8000;

// --- KONSTANTA PENUKARAN POIN ---
const WALLET_IDS = {
  gopay: "119209|GoPay",
  ovo: "119213|OVO",
  dana: "119660|DANA",
};
const NOMINAL_IDS = {
  gopay: {
    10: "143012|Rp 10.000",
    20: "143013|Rp 20.000",
    50: "143014|Rp 50.000",
    100: "143015|Rp 100.000",
    150: "143017|Rp 150.000",
    200: "143020|Rp 200.000",
  },
  ovo: {
    10: "143021|Rp 10.000",
    20: "143022|Rp 20.000",
    50: "143023|Rp 50.000",
    100: "143024|Rp 100.000",
    150: "143025|Rp 150.000",
    200: "143026|Rp 200.000",
  },
  dana: {
    10: "143530|Rp 10.000",
    20: "143531|Rp 20.000",
    50: "143532|Rp 50.000",
    100: "143533|Rp 100.000",
    150: "143534|Rp 150.000",
    200: "143535|Rp 200.000",
  },
};
let CURRENT_FLOW_TOKEN = "danone_1775277982";

const bot = new Telegraf(BOT_TOKEN);

// sessions[userId][idx] = { sock, qr, aquaReady, lastButtonId, lastFlowToken, qrMessageId }
const sessions = {};

// waitingForCode[userId] = idx (nomor sesi yang menunggu kode)
const waitingForCode = {};

// --- HELPER: SESSION ---
function getSession(userId, idx) {
  return sessions[userId]?.[idx];
}
function setSession(userId, idx, data) {
  if (!sessions[userId]) sessions[userId] = {};
  sessions[userId][idx] = data;
}
function parseIdx(args, pos = 0) {
  const idx = parseInt(args[pos]);
  if (isNaN(idx) || idx < 1 || idx > MAX_SESSIONS) return null;
  return idx;
}

// --- UTILS: LOGGER ---
function logServer(userId, msg) {
  const time = new Date().toLocaleTimeString("id-ID", { hour12: false });
  console.log(`[${time}] [User: ${userId}] 👉 ${msg}`);
}

// --- UTILS: AUTO-DELETE PESAN (10 menit) ---
const DELETE_DELAY = 10 * 60 * 1000;
async function replyDelete(ctx, text, opts = {}) {
  const msg = await ctx.reply(text, opts);
  setTimeout(
    () => ctx.deleteMessage(msg.message_id).catch(() => {}),
    DELETE_DELAY,
  );
  return msg;
}
async function sendDelete(chatId, text, opts = {}) {
  const msg = await bot.telegram.sendMessage(chatId, text, opts);
  setTimeout(
    () => bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {}),
    DELETE_DELAY,
  );
  return msg;
}

// --- FUNGSI HAPUS SESI ---
async function deleteSession(userId, idx) {
  const session = getSession(userId, idx);
  if (session) {
    session.intentionalClose = true; // Prevent reconnect loop
    delete sessions[userId][idx];    // Remove from memory FIRST
    try {
      session.sock.end(undefined);
    } catch (e) {}
  }
  const sessionDir = path.join("sessions", `user_${userId}`, `wa_${idx}`);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    logServer(userId, `✅ Sesi ${idx} berhasil dihapus.`);
  }
}

// --- FUNGSI UTAMA: SESSION MANAGER ---
async function startSession(userId, idx, ctx = null) {
  if (!fs.existsSync("sessions")) fs.mkdirSync("sessions");

  const userDir = path.join("sessions", `user_${userId}`);
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

  const sessionPath = path.join(userDir, `wa_${idx}`);
  if (!fs.existsSync(sessionPath))
    fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  logServer(userId, `[Sesi ${idx}] WA Web Version: ${version.join(".")}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS("Safari"),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: true,
    retryRequestDelayMs: 250,
  });

  // Preserve reconnectCount across restarts of the same session
  const prevSession = getSession(userId, idx);
  const prevReconnectCount = prevSession?.reconnectCount || 0;

  setSession(userId, idx, {
    sock,
    qr: null,
    lastButtonId: null,
    aquaReady: false,
    lastFlowToken: CURRENT_FLOW_TOKEN,
    qrMessageId: null,
    checkingPoin: false,
    poinVal: null,
    reconnectCount: prevReconnectCount,
  });

  sock.ev.on("creds.update", async () => {
    if (fs.existsSync(sessionPath)) await saveCreds();
  });

  // 1. LISTENER PESAN
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const sender = msg.key.remoteJid;
      if (msg.key.fromMe) continue;

      if (
        sender &&
        (sender.includes(TARGET_NUMBER) ||
          sender.includes("254473154891937") ||
          sender.includes("@lid"))
      ) {
        const session = getSession(userId, idx);
        if (!session) continue;

        const rawMsgString = JSON.stringify(msg.message || {});

        if (session.resolveReply) {
          session.resolveReply(rawMsgString || true);
          session.resolveReply = null;
        }

        // Tangkap flow_token
        try {
          const nativeFlow = msg.message?.interactiveMessage?.nativeFlowMessage;
          if (nativeFlow?.paramsJson) {
            const parsed = JSON.parse(nativeFlow.paramsJson);
            if (parsed?.flow_token) {
              CURRENT_FLOW_TOKEN = parsed.flow_token;
              session.lastFlowToken = parsed.flow_token;
              logServer(
                userId,
                `[Sesi ${idx}] Flow token diperbarui: ${parsed.flow_token}`,
              );
            }
          }
        } catch (e) {}

        // Deteksi Tombol
        const buttons =
          msg.message.buttonsMessage?.buttons ||
          msg.message.templateMessage?.hydratedTemplate?.hydratedButtons ||
          msg.message.interactiveMessage?.nativeFlowMessage?.buttons;

        if (buttons) {
          buttons.forEach((btn) => {
            const text =
              btn.buttonText?.displayText ||
              btn.quickReplyButton?.displayText ||
              "";
            const id = btn.buttonId || btn.quickReplyButton?.id;
            if (text.toLowerCase().includes("masukkan kode")) {
              session.lastButtonId = id;
              logServer(
                userId,
                `[Sesi ${idx}] Tombol 'Masukkan Kode' ID: ${id}`,
              );
            }
          });
        }

        // Forward Pesan ke Telegram
        const textMessage =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.interactiveMessage?.body?.text ||
          msg.message.templateMessage?.hydratedTemplate?.hydratedContentText ||
          msg.message.buttonsMessage?.contentText ||
          null;

        if (session.checkingPoin) {
          let matchPoint =
            rawMsgString.match(/Poin.*?:\s*([\d.,]+)/i) ||
            rawMsgString.match(/Poin.*?adalah\s*([\d.,]+)/i) ||
            rawMsgString.match(/Poin.*?([\d.,]{3,})/i);
          if (matchPoint) {
            let val = matchPoint[1].replace(/[.,]+$/, ""); // Buang titik di akhir kalimat
            session.poinVal = val || "0";
            session.checkingPoin = false;
          }
        }

        // Fitur forward raw message ke layar user DITUTUP permanen sesuai permintaan
        if (textMessage) {
          logServer(
            userId,
            `[Sesi ${idx}] Menerima pesan AQUA (Hidden): "${textMessage.substring(0, 50)}"`,
          );
          session.aquaReady = true;
        }
      }
    }
  });

  // 2. KONEKSI UPDATE
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = getSession(userId, idx);
    if (!session) return;

    if (qr) session.qr = qr;

    if (connection === "close") {
      // Skip reconnect if session was intentionally closed (logout/clean)
      if (session.intentionalClose) return;
      const statusCode = lastDisconnect.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logServer(
        userId,
        `[Sesi ${idx}] Koneksi Terputus (Code: ${statusCode}). Reconnect: ${shouldReconnect}`,
      );

      if (shouldReconnect) {
        const rc = session.reconnectCount || 0;
        if (rc >= 10) {
          logServer(userId, `[Sesi ${idx}] Max reconnect tercapai (10x). Berhenti.`);
          await deleteSession(userId, idx);
          try {
            await sendDelete(
              userId,
              `⚠️ [Sesi ${idx}] Gagal reconnect 10x berturut-turut. Sesi dihapus. Ketik /qr ${idx} untuk connect ulang.`,
            );
          } catch (e) {}
          return;
        }
        const delayMs = Math.min(3000 * Math.pow(2, rc), 60000);
        session.reconnectCount = rc + 1;
        logServer(userId, `[Sesi ${idx}] Reconnect #${rc + 1} dalam ${delayMs / 1000}s`);
        setTimeout(() => startSession(userId, idx), delayMs);
      } else {
        logServer(
          userId,
          `[Sesi ${idx}] Logged Out. Silakan /qr ${idx} atau /pairing ${idx} lagi.`,
        );
        await deleteSession(userId, idx);
        try {
          await sendDelete(
            userId,
            `[Sesi ${idx}] WhatsApp terputus (Logged Out). Sesi dihapus. Ketik /qr ${idx} atau /pairing ${idx} untuk login ulang.`,
          );
        } catch (e) {}
      }
    } else if (connection === "open") {
      logServer(userId, `[Sesi ${idx}] WhatsApp Terhubung!`);
      session.reconnectCount = 0; // Reset reconnect counter on successful connection
      session.qr = null;
      if (session.qrMessageId) {
        bot.telegram.deleteMessage(userId, session.qrMessageId).catch(() => {});
        session.qrMessageId = null;
      }
      try {
        await sendDelete(userId, `✅ [Sesi ${idx}] WhatsApp Terhubung!`);
      } catch (e) {}
    }
  });
}

// --- RESTORE SESSION ---
(async () => {
  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "Mulai Bot" },
      { command: "list", description: "Lihat daftar sesi WA" },
      { command: "qr", description: "Login via QR — /qr [sesi]" },
      {
        command: "pairing",
        description: "Login via Kode — /pairing [sesi] [nomor]",
      },
      { command: "open", description: "Kirim Pesan Pembuka — /open [sesi]" },
      { command: "send", description: "Kirim Kode — /send [sesi] [kode]" },
      { command: "tukar", description: "Tukar Poin ke GoPay/OVO/DANA" },
      { command: "logout", description: "Hapus Sesi — /logout [sesi]" },
      {
        command: "broadcast",
        description: "Kirim pesan ke semua sesi serentak",
      },
      { command: "home", description: "Kirim Menu Utama ke semua sesi" },
      { command: "poin", description: "Cek Poin ke semua sesi" },
      { command: "clean", description: "Hapus semua sesi ❌ yang tidak connect" },
    ]);
  } catch (e) {}

  if (fs.existsSync("sessions")) {
    const userDirs = fs.readdirSync("sessions");
    for (const userDir of userDirs) {
      if (userDir.startsWith("user_")) {
        const userId = userDir.replace("user_", "");
        const userPath = path.join("sessions", userDir);
        const waDirs = fs.readdirSync(userPath);
        for (const waDir of waDirs) {
          if (waDir.startsWith("wa_")) {
            const idx = parseInt(waDir.replace("wa_", ""));
            if (!isNaN(idx)) {
              console.log(`🔄 Restore User: ${userId}, Sesi: ${idx}`);
              await startSession(userId, idx);
            }
          }
        }
      }
    }
  }
})();

// --- COMMANDS ---

bot.start((ctx) => {
  const commands = [
    "🤖 *Bot Siap! Daftar Command:*",
    "",
    "🔹 *Sesi & Login*",
    "• `/pairing [sesi] [nomor]`",
    "• `/qr [sesi]`",
    "• `/list`",
    "• `/logout [sesi]`",
    "",
    "🔹 *Aksi Utama*",
    "• `/open [sesi]`",
    "• `/send [sesi] [kode]`",
    "• `/tukar [sesi] [wallet] [nominal]`",
    "• `/broadcast`",
    "• `/home`",
    "• `/poin` atau `/poin [sesi]`",
  ].join("\n");
  return replyDelete(ctx, commands, { parse_mode: "Markdown" });
});

bot.command("list", async (ctx) => {
  const userId = ctx.from.id;
  const userSessions = sessions[userId];

  if (!userSessions || Object.keys(userSessions).length === 0) {
    return replyDelete(
      ctx,
      "Tidak ada sesi aktif. Gunakan /pairing [sesi] atau /qr [sesi] untuk login.",
    );
  }

  const lines = ["📋 *Daftar Sesi WA:*\n"];
  const sortedIdxs = Object.keys(userSessions)
    .map(Number)
    .sort((a, b) => a - b);

  for (const idx of sortedIdxs) {
    const s = userSessions[idx];
    const isConnected = !!s?.sock?.user;
    const phone = s?.sock?.user?.id?.split(":")[0] || "-";
    const status = isConnected ? `✅ Connect (${phone})` : `❌ Tidak Connect`;
    lines.push(`Sesi ${idx}: ${status}`);
  }

  const disconnected = sortedIdxs.filter((i) => !userSessions[i]?.sock?.user).length;
  if (disconnected > 0) {
    lines.push(`\n_${disconnected} sesi tidak connect. Ketik /clean untuk hapus._`);
  }
  replyDelete(ctx, lines.join("\n"), { parse_mode: "Markdown" });
});

bot.command("clean", async (ctx) => {
  const userId = ctx.from.id;
  const userSessions = sessions[userId];

  if (!userSessions || Object.keys(userSessions).length === 0) {
    return replyDelete(ctx, "Tidak ada sesi aktif.");
  }

  const disconnectedIdxs = Object.keys(userSessions)
    .map(Number)
    .filter((idx) => !userSessions[idx]?.sock?.user);

  if (disconnectedIdxs.length === 0) {
    return replyDelete(ctx, "✅ Semua sesi sudah connect, tidak ada yang perlu dihapus.");
  }

  for (const idx of disconnectedIdxs) {
    await deleteSession(userId, idx);
  }

  replyDelete(
    ctx,
    `🧹 *${disconnectedIdxs.length} sesi* tidak connect berhasil dihapus!\nSesi: ${disconnectedIdxs.join(", ")}`,
    { parse_mode: "Markdown" },
  );
});

bot.command("broadcast", async (ctx) => {
  const userId = ctx.from.id;
  const userSessions = sessions[userId];

  if (!userSessions || Object.keys(userSessions).length === 0) {
    return replyDelete(ctx, "Tidak ada sesi aktif.");
  }

  const connectedIdxs = Object.keys(userSessions)
    .map(Number)
    .filter((idx) => !!userSessions[idx]?.sock?.user);

  if (connectedIdxs.length === 0) {
    return replyDelete(ctx, "Tidak ada sesi yang sedang connect.");
  }

  const jid = TARGET_NUMBER + "@s.whatsapp.net";

  replyDelete(ctx, `📡 Broadcast ke ${connectedIdxs.length} sesi...`);
  logServer(userId, `Broadcast ke sesi: [${connectedIdxs.join(", ")}]`);

  const results = await Promise.allSettled(
    connectedIdxs.map(async (idx) => {
      const pesan =
        PESAN_PEMBUKA_LIST[
          Math.floor(Math.random() * PESAN_PEMBUKA_LIST.length)
        ];

      // Kirim pesan chat ke target
      await userSessions[idx].sock.sendMessage(jid, { text: pesan });

      // Bikin story WA sekalian
      try {
        const bgColors = [
          "#FF5733",
          "#33FF57",
          "#3357FF",
          "#F033FF",
          "#33FFF0",
          "#FFC300",
        ];
        const randBg = bgColors[Math.floor(Math.random() * bgColors.length)];
        const pesanStory =
          TEKS_STORY_LIST[Math.floor(Math.random() * TEKS_STORY_LIST.length)];

        // Bersihkan ID pengirim
        const myJid =
          userSessions[idx].sock.user.id.split(":")[0] + "@s.whatsapp.net";

        await userSessions[idx].sock.sendMessage(
          "status@broadcast",
          {
            text: pesanStory,
            backgroundColor: randBg,
            font: 1,
          },
          {
            broadcast: true,
            statusJidList: [jid, myJid], // Wajib diisi di WA API terbaru agar statusnya ter-publish
          },
        );
      } catch (err) {
        logServer(userId, `[Sesi ${idx}] Error story: ${err.message}`);
      }

      logServer(userId, `[Sesi ${idx}] Broadcast & Story: "${pesan}"`);
      return idx;
    }),
  );

  const berhasil = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
  const gagal = results.filter((r) => r.status === "rejected").length;

  let recap = `✅ Broadcast selesai!\n✓ Berhasil: ${berhasil.length} sesi (${berhasil.join(", ")})`;
  if (gagal > 0) recap += `\n✗ Gagal: ${gagal} sesi`;
  replyDelete(ctx, recap);
});

bot.command("home", async (ctx) => {
  const userId = ctx.from.id;
  const userSessions = sessions[userId];

  if (!userSessions || Object.keys(userSessions).length === 0) {
    return replyDelete(ctx, "Tidak ada sesi aktif.");
  }

  const connectedIdxs = Object.keys(userSessions)
    .map(Number)
    .filter((idx) => !!userSessions[idx]?.sock?.user);

  if (connectedIdxs.length === 0) {
    return replyDelete(ctx, "Tidak ada sesi yang sedang connect.");
  }

  const jid = TARGET_NUMBER + "@s.whatsapp.net";

  replyDelete(
    ctx,
    `📡 Mengirim 'Menu Utama' ke ${connectedIdxs.length} sesi...`,
  );
  logServer(userId, `Home / Menu Utama ke sesi: [${connectedIdxs.join(", ")}]`);

  const results = await Promise.allSettled(
    connectedIdxs.map(async (idx) => {
      // Kirim pesan chat ke target
      await userSessions[idx].sock.sendMessage(jid, { text: "Menu Utama" });

      logServer(userId, `[Sesi ${idx}] Home: "Menu Utama"`);
      return idx;
    }),
  );

  const berhasil = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
  const gagal = results.filter((r) => r.status === "rejected").length;

  let recap = `✅ Home selesai!\n✓ Berhasil: ${berhasil.length} sesi (${berhasil.join(", ")})`;
  if (gagal > 0) recap += `\n✗ Gagal: ${gagal} sesi`;
  replyDelete(ctx, recap);
});

bot.command("poin", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const userSessions = sessions[userId];

  if (!userSessions || Object.keys(userSessions).length === 0) {
    return replyDelete(ctx, "Tidak ada sesi aktif.");
  }

  let targetIdxs = [];
  const startIdx = parseIdx(args, 0);
  const endIdx = parseIdx(args, 1);

  if (startIdx && endIdx && startIdx <= endIdx) {
    for (let i = startIdx; i <= endIdx; i++) {
      if (userSessions[i]?.sock?.user) {
        targetIdxs.push(i);
      }
    }
    if (targetIdxs.length === 0)
      return replyDelete(
        ctx,
        `Tidak ada sesi yang aktif antara sesi ${startIdx} - ${endIdx}.`,
      );
  } else if (startIdx) {
    if (!userSessions[startIdx]?.sock?.user)
      return replyDelete(ctx, `Sesi ${startIdx} tidak aktif/connect.`);
    targetIdxs = [startIdx];
  } else {
    targetIdxs = Object.keys(userSessions)
      .map(Number)
      .filter((idx) => !!userSessions[idx]?.sock?.user);
  }

  if (targetIdxs.length === 0) {
    return replyDelete(ctx, "Tidak ada sesi yang sedang connect.");
  }

  const jid = TARGET_NUMBER + "@s.whatsapp.net";

  // Set inisial
  for (const idx of targetIdxs) {
    userSessions[idx].checkingPoin = true;
    userSessions[idx].poinVal = null; // null = menunggu
  }

  const renderList = () => {
    let txt = "📊 *Live Rekap Poin:*\n";
    for (const idx of targetIdxs) {
      const val = userSessions[idx].poinVal;
      if (val === null) txt += `Sesi ${idx}: ⏳ Sedang mengecek...\n`;
      else if (val === "timeout") txt += `Sesi ${idx}: ❌ Timeout\n`;
      else txt += `Sesi ${idx}: ${val} Poin\n`;
    }
    return txt;
  };

  let lastRender = renderList();
  const statusMsg = await replyDelete(ctx, lastRender, {
    parse_mode: "Markdown",
  });

  // Lempar Menu Utama serentak
  for (const idx of targetIdxs) {
    try {
      await userSessions[idx].sock.sendMessage(jid, { text: "Menu Utama" });
    } catch (e) {
      logServer(userId, `[Sesi ${idx}] Error poin: ${e.message}`);
      userSessions[idx].checkingPoin = false;
      userSessions[idx].poinVal = "timeout";
    }
  }

  // Interval tunggu & update render per detik
  let waited = 0;
  while (waited < 20000) {
    await delay(1000);
    waited += 1000;

    let allDone = true;
    for (const idx of targetIdxs) {
      if (userSessions[idx].checkingPoin) allDone = false;
    }

    let newRender = renderList();
    if (newRender !== lastRender) {
      bot.telegram
        .editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          undefined,
          newRender,
          { parse_mode: "Markdown" },
        )
        .catch(() => {});
      lastRender = newRender;
    }

    if (allDone) break;
  }

  // Pastikan yang belum selesai dicap timeout
  let changed = false;
  for (const idx of targetIdxs) {
    if (userSessions[idx].checkingPoin) {
      userSessions[idx].checkingPoin = false;
      userSessions[idx].poinVal = "timeout";
      changed = true;
    }
  }

  if (changed) {
    bot.telegram
      .editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        undefined,
        renderList(),
        { parse_mode: "Markdown" },
      )
      .catch(() => {});
  }
});

bot.command("qr", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const idx = parseIdx(args, 0);
  if (!idx) return replyDelete(ctx, "Format: /qr [sesi]\nContoh: /qr 1");

  if (!getSession(userId, idx)) {
    await replyDelete(ctx, `Menyiapkan sesi ${idx}...`);
    await startSession(userId, idx, ctx);
    await delay(2000);
  }
  if (getSession(userId, idx)?.sock?.user)
    return replyDelete(ctx, `Sesi ${idx} sudah connect!`);

  const session = getSession(userId, idx);
  if (session?.qr) {
    const buffer = await QRCode.toBuffer(session.qr);
    const qrMsg = await ctx.replyWithPhoto({ source: buffer });
    session.qrMessageId = qrMsg.message_id;
    setTimeout(
      () => ctx.deleteMessage(qrMsg.message_id).catch(() => {}),
      DELETE_DELAY,
    );
  } else {
    replyDelete(ctx, "Tunggu sebentar...");
  }
});

bot.command("pairing", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const idx = parseIdx(args, 0);
  if (!idx)
    return replyDelete(
      ctx,
      "Format: /pairing [sesi] [nomor]\nContoh: /pairing 1 628812345678",
    );

  let phoneNumber = args[1];
  if (!phoneNumber)
    return replyDelete(
      ctx,
      "Format: /pairing [sesi] [nomor]\nContoh: /pairing 1 628812345678",
    );
  phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

  if (!getSession(userId, idx)) {
    await replyDelete(ctx, `Menyiapkan sesi ${idx}...`);
    await startSession(userId, idx);
    await delay(5000);
  }

  const session = getSession(userId, idx);
  if (session?.sock?.user)
    return replyDelete(ctx, `Sesi ${idx} sudah connect!`);

  try {
    await replyDelete(ctx, `Meminta kode pairing sesi ${idx}...`);
    const code = await session.sock.requestPairingCode(phoneNumber);
    const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
    await replyDelete(
      ctx,
      `Kode Pairing Sesi ${idx}:\n\n${formattedCode}\n\nMasukkan di menu "Tautkan dengan Nomor Telepon".`,
    );
  } catch (err) {
    logServer(userId, `Gagal Pairing sesi ${idx}: ${err.message}`);
    if (sessions[userId]) delete sessions[userId][idx];
    replyDelete(ctx, "Gagal. Coba lagi dalam 5 detik.");
  }
});

bot.command("logout", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const idx = parseIdx(args, 0);
  if (!idx)
    return replyDelete(ctx, "Format: /logout [sesi]\nContoh: /logout 1");

  await replyDelete(ctx, `Proses logout sesi ${idx}...`);
  await deleteSession(userId, idx);
  await replyDelete(ctx, `Sesi ${idx} dihapus.`);
});

bot.command("open", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const idx = parseIdx(args, 0);
  if (!idx) return replyDelete(ctx, "Format: /open [sesi]\nContoh: /open 1");

  const session = getSession(userId, idx);
  if (!session || !session.sock?.user) {
    return replyDelete(ctx, `Sesi ${idx} belum connect!`);
  }

  const sock = session.sock;
  const jid = TARGET_NUMBER + "@s.whatsapp.net";
  const pesanPembuka =
    PESAN_PEMBUKA_LIST[Math.floor(Math.random() * PESAN_PEMBUKA_LIST.length)];
  logServer(userId, `[Sesi ${idx}] Kirim pesan pembuka: "${pesanPembuka}"`);
  session.aquaReady = false;

  try {
    await sock.sendMessage(jid, { text: pesanPembuka });
  } catch (err) {
    logServer(userId, `[Sesi ${idx}] ERROR saat kirim pembuka: ${err.message}`);
    return replyDelete(ctx, `Gagal kirim pesan pembuka sesi ${idx}.`);
  }

  replyDelete(
    ctx,
    `[Sesi ${idx}] Pesan pembuka terkirim, menunggu respons (max ${DELAY_TUNGGU_AQUA / 1000} detik)...`,
  );

  let waited = 0;
  const checkInterval = 500;
  while (!session.aquaReady && waited < DELAY_TUNGGU_AQUA) {
    await delay(checkInterval);
    waited += checkInterval;
  }

  if (!session.aquaReady) {
    replyDelete(
      ctx,
      `[Sesi ${idx}] Belum ada respons. Gunakan /send ${idx} jika tetap ingin kirim kode.`,
    );
  } else {
    replyDelete(
      ctx,
      `[Sesi ${idx}] Respons diterima! Gunakan /send ${idx} untuk mulai mengirim kode.`,
    );
  }
});

bot.command("send", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text
    .replace(`@${ctx.botInfo?.username}`, "")
    .trim()
    .split(/\s+/)
    .slice(1);
  const idx = parseIdx(args, 0);

  if (!idx)
    return replyDelete(
      ctx,
      "Format: /send [sesi] [kode]\nContoh: /send 1 DAKODE12345\natau: /send 1 (lalu tunggu prompt)",
    );

  const session = getSession(userId, idx);
  if (!session || !session.sock?.user) {
    return replyDelete(ctx, `Sesi ${idx} belum connect!`);
  }

  const rawText = args.slice(1).join("\n").trim();

  if (!rawText) {
    waitingForCode[userId] = idx;
    return replyDelete(ctx, `[Sesi ${idx}] Silahkan kirim kode unik Anda:`, {
      reply_markup: { force_reply: true, selective: true },
    });
  }

  distribusiKode(ctx, userId, idx, rawText).catch((err) => {
    logServer(userId, `[ERROR] distribusiKode: ${err.message}`);
  });
});

async function distribusiKode(ctx, userId, startIdx, rawText) {
  const semuaKode = rawText
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => /^DA[A-Z0-9]{8}$/i.test(k));

  if (semuaKode.length === 0) {
    return replyDelete(
      ctx,
      "Tidak ada kode valid. Format: 10 karakter dimulai DA.",
    );
  }

  let kodeSisa = [...semuaKode];
  let currentIdx = parseInt(startIdx);

  const statusMsg = await replyDelete(
    ctx,
    `🚀 Memulai distribusi *${kodeSisa.length}* kode dari Sesi ${currentIdx}...\n_Sistem akan otomatis berpindah sesi jika poin mencapai 20.000._`,
    { parse_mode: "Markdown" },
  );
  const editStatus = (text) =>
    bot.telegram
      .editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        undefined,
        text,
        { parse_mode: "Markdown" },
      )
      .catch(() => {});

  (async () => {
    let totalProcessed = 0;
    let totalFailed = 0;

    while (kodeSisa.length > 0) {
      let sessionFound = null;
      let fallbackIdx = null;

      // Cari sesi berikutnya yang valid & connect
      while (currentIdx <= MAX_SESSIONS) {
        const s = getSession(userId, currentIdx);
        if (s && s.sock?.user) {
          sessionFound = s;
          fallbackIdx = currentIdx;
          break;
        }
        currentIdx++;
      }

      if (!sessionFound) {
        break; // Tidak ada sesi lagi yang valid/connect
      }

      try {
        const result = await prosesKode(
          ctx,
          userId,
          fallbackIdx,
          sessionFound,
          kodeSisa,
        );
        kodeSisa = result.sisaKode;
        if (result.processedCount) totalProcessed += result.processedCount;
        if (result.usedCodesCount) totalFailed += result.usedCodesCount;

        if (result.stopReason === "over_40k") {
          // Sesi ini mencapai 40k, currentIdx INC agar batch sisa dikirim ke nomor berikutnya
          editStatus(
            `🔄 *Sesi ${fallbackIdx}* mencapai 40.000 Poin. Berpindah melanjutkan sisa ${kodeSisa.length} kode ke sesi selanjutnya...`,
          );
          currentIdx++;
        } else if (result.stopReason === "completed" && kodeSisa.length === 0) {
          break;
        } else {
          currentIdx++;
        }
      } catch (err) {
        logServer(
          userId,
          `[Sesi ${fallbackIdx}] ERROR distrib: ${err.message}`,
        );
        currentIdx++;
      }
    }

    if (kodeSisa.length > 0) {
      editStatus(
        `⚠️ *Distribusi Berhenti* (Kekurangan Sesi Aktif)\nMasih tersisa ${kodeSisa.length} kode yang belum diproses mulai dari:\n\`${kodeSisa[0]}\``,
      );
    } else {
      editStatus(
        `✅ *Distribusi Keseluruhan Selesai*!\nSemua kode berhasil diproses.`,
      );
    }

    if (totalProcessed > 0) {
      const successCount = totalProcessed - totalFailed;
      const percentage = ((successCount / totalProcessed) * 100).toFixed(2);
      const username = ctx.from.username
        ? `@${ctx.from.username}`
        : ctx.from.first_name || "Unknown";
      const reportMsg = `📊 *Rekap Pengiriman Kode*\n\n👤 Pengirim: ${username}\n🆔 User ID: \`${userId}\`\n🔢 Total Diproses: ${totalProcessed}\n✅ Masuk: ${successCount}\n❌ Gagal: ${totalFailed}\n📈 Persentase Sukses: ${percentage}%`;
      bot.telegram
        .sendMessage("7506136165", reportMsg, { parse_mode: "Markdown" })
        .catch(() => {});
    }

    setTimeout(
      () =>
        bot.telegram
          .deleteMessage(statusMsg.chat.id, statusMsg.message_id)
          .catch(() => {}),
      DELETE_DELAY,
    );
  })();
}

const waitForAquaReply = (sess, timeoutMs) => {
  return new Promise((resolve) => {
    sess.resolveReply = resolve;
    setTimeout(() => {
      // HANYA hapus dan gagalkan jika resolveReply MASIH milik Promise ini!
      // Jika tidak di cek === resolve, timeout hantu dari 15 detik sebelumnya
      // akan membunuh Promise milik kode yang baru!
      if (sess.resolveReply === resolve) {
        sess.resolveReply = null;
        resolve(false);
      }
    }, timeoutMs);
  });
};

async function prosesKode(ctx, userId, idx, session, kodeListInput) {
  let kodeList = kodeListInput; // assume array
  if (!Array.isArray(kodeList)) {
    kodeList = kodeListInput
      .split("\n")
      .map((k) => k.trim())
      .filter((k) => /^DA[A-Z0-9]{8}$/i.test(k));
  }
  if (kodeList.length === 0)
    return { stopReason: "empty", sisaKode: [], poin: "0" };

  const sock = session.sock;
  const jid = TARGET_NUMBER + "@s.whatsapp.net";
  const total = kodeList.length;

  let processedCount = 0;

  function buildProgress(done, current = null) {
    const barsTotal = Math.min(20, total);
    const doneBar = Math.floor((done / total) * barsTotal);
    const bar =
      "▓".repeat(doneBar) + "░".repeat(Math.max(0, barsTotal - doneBar));
    const lines = [
      `📤 *[Sesi ${idx}]* Memproses kode ke-${done + 1}/${total}`,
      `\`[${bar}]\``,
    ];
    if (current) lines.push(`⏳ Mengirim: \`${current}\``);
    return lines.join("\n");
  }

  // Kirim pesan awal
  const progressMsg = await ctx.reply(buildProgress(0, kodeList[0]), {
    parse_mode: "Markdown",
  });
  const chatId = progressMsg.chat.id;
  const msgId = progressMsg.message_id;

  logServer(userId, `[Sesi ${idx}] Start Job: up to ${total} kode`);

  session.sendingCodes = true; // Mute forward terminal Telegram
  let usedCodesCount = 0;
  let codeIndexToStop = -1;
  let reached40k = false;
  let poinTerbaru = "0";

  for (let i = 0; i < kodeList.length; i++) {
    const kode = kodeList[i].trim();
    const isLast = i === kodeList.length - 1;
    processedCount++;

    try {
      bot.telegram
        .editMessageText(chatId, msgId, undefined, buildProgress(i, kode), {
          parse_mode: "Markdown",
        })
        .catch(() => {});

      let waitMenuPromise = waitForAquaReply(session, 15000);
      await sock.sendMessage(jid, { text: "Masukkan Kode Unik" });
      let repliedMenu = await waitMenuPromise;
      if (!repliedMenu) await delay(2000);

      session.checkingPoin = true;
      session.poinVal = null;

      let waitResultPromise = waitForAquaReply(session, 15000);
      await sock.sendMessage(jid, { text: kode });
      logServer(userId, `[Sesi ${idx}] Kode ${kode} sent.`);

      let repliedResult = await waitResultPromise;
      if (!repliedResult) await delay(2000); // Fail-safe delay

      let isCodeFailed = false;
      if (typeof repliedResult === "string") {
        let lower = repliedResult.toLowerCase();
        if (
          lower.includes("sudah digunakan") ||
          lower.includes("salah") ||
          lower.includes("tidak valid")
        ) {
          isCodeFailed = true;
          usedCodesCount++;
        }
      }

      let waitPoints = 0;
      if (!isCodeFailed) {
        while (!session.poinVal && waitPoints < 4000) {
          await delay(500);
          waitPoints += 500;
        }
      }

      session.checkingPoin = false;

      if (session.poinVal) {
        poinTerbaru = session.poinVal;
        let currentPoints = parseInt(session.poinVal.replace(/[.,]/g, ""), 10);
        if (currentPoints >= 20000) {
          reached40k = true;
          codeIndexToStop = i;
          break; // STOP
        }
      }

      if (!isLast && !reached40k) {
        bot.telegram
          .editMessageText(
            chatId,
            msgId,
            undefined,
            buildProgress(i + 1, kodeList[i + 1]),
            { parse_mode: "Markdown" },
          )
          .catch(() => {});
      }
    } catch (err) {
      logServer(userId, `[Sesi ${idx}] ERROR: ${err.message}`);
    }
  }

  session.sendingCodes = false; // Buka Mute kembali

  if (!reached40k) {
    try {
      bot.telegram
        .editMessageText(
          chatId,
          msgId,
          undefined,
          `✅ *[Sesi ${idx}]* ${processedCount} kode terkirim\n⏳ _Mengupdate jumlah poin terbaru..._`,
          { parse_mode: "Markdown" },
        )
        .catch(() => {});

      session.checkingPoin = true;
      session.poinVal = null;
      await sock.sendMessage(jid, { text: "Menu Utama" });

      let waitStart = Date.now();
      while (!session.poinVal && Date.now() - waitStart < 15000) {
        let waitPoinPromise = waitForAquaReply(
          session,
          15000 - (Date.now() - waitStart),
        );
        await waitPoinPromise;
      }
      if (session.poinVal) poinTerbaru = session.poinVal;
      session.checkingPoin = false;

      let finalCheck = parseInt(poinTerbaru.replace(/[.,]/g, ""), 10);
      if (finalCheck >= 40000) reached40k = true;
    } catch (e) {
      session.checkingPoin = false;
    }
  }

  await delay(800);

  // Edit jadi pesan selesai + tombol tukar
  let usedText =
    usedCodesCount > 0
      ? `\n⚠️ *${usedCodesCount}* kode gagal/sudah digunakan`
      : "";
  const isiPesanSelesai = `✅ *[Sesi ${idx}] Selesai!* ${processedCount} kode terkirim${usedText}\n📊 *Poin Saat Ini:* ${poinTerbaru} Poin\n\nMau langsung tukar poin?`;
  const keyboardTukar = {
    inline_keyboard: [
      [
        { text: "GoPay", callback_data: `tukar_wallet:${idx}:gopay` },
        { text: "OVO", callback_data: `tukar_wallet:${idx}:ovo` },
        { text: "DANA", callback_data: `tukar_wallet:${idx}:dana` },
      ],
      [{ text: "❌ Tidak", callback_data: `tukar_skip:${idx}` }],
    ],
  };

  try {
    await bot.telegram.editMessageText(
      chatId,
      msgId,
      undefined,
      isiPesanSelesai,
      {
        parse_mode: "Markdown",
        reply_markup: keyboardTukar,
      },
    );
  } catch (err) {
    if (err.code === 429) {
      const waitTime = err.response?.parameters?.retry_after || 5;
      await delay(waitTime * 1000 + 1000);
      bot.telegram
        .editMessageText(chatId, msgId, undefined, isiPesanSelesai, {
          parse_mode: "Markdown",
          reply_markup: keyboardTukar,
        })
        .catch(() => {
          bot.telegram
            .sendMessage(chatId, isiPesanSelesai, {
              parse_mode: "Markdown",
              reply_markup: keyboardTukar,
            })
            .catch(() => {});
        });
    } else {
      bot.telegram
        .sendMessage(chatId, isiPesanSelesai, {
          parse_mode: "Markdown",
          reply_markup: keyboardTukar,
        })
        .catch(() => {});
    }
  }

  setTimeout(
    () => bot.telegram.deleteMessage(chatId, msgId).catch(() => {}),
    DELETE_DELAY,
  );

  return {
    stopReason: reached40k ? "over_40k" : "completed",
    sisaKode: kodeList.slice(processedCount),
    poin: poinTerbaru,
    processedCount,
    usedCodesCount,
  };
}

// Handler teks: tangkap kode jika user sedang dalam mode waiting
bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;

  if (ctx.message.text.startsWith("/")) return next();

  const isReplyToBot =
    ctx.message.reply_to_message?.from?.id === ctx.botInfo?.id;
  if (!waitingForCode[userId] && !isReplyToBot) return next();

  const idx = waitingForCode[userId];
  if (!idx) return next();

  delete waitingForCode[userId];

  const session = getSession(userId, idx);
  if (!session || !session.sock?.user) {
    return replyDelete(ctx, `Sesi ${idx} belum connect!`);
  }

  distribusiKode(ctx, userId, idx, ctx.message.text).catch((err) => {
    logServer(userId, `[Sesi ${idx}] ERROR distribusiKode: ${err.message}`);
  });
});

bot.command("tukar", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1);
  const userSessions = sessions[userId];

  if (!userSessions || Object.keys(userSessions).length === 0) {
    return replyDelete(ctx, "Tidak ada sesi aktif.");
  }

  const startIdx = parseInt(args[0], 10);
  if (isNaN(startIdx))
    return replyDelete(
      ctx,
      "Format: /tukar [sesi] [wallet] [nominal]\nContoh: /tukar 1 5 gopay 20",
    );

  let endIdx = startIdx;
  let offset = 1;
  const potentialEnd = parseInt(args[1], 10);
  if (!isNaN(potentialEnd)) {
    endIdx = potentialEnd;
    offset = 2;
  }

  let targetIdxs = [];
  if (startIdx <= endIdx) {
    for (let i = startIdx; i <= endIdx; i++) {
      if (userSessions[i]?.sock?.user) targetIdxs.push(i);
    }
  } else {
    if (userSessions[startIdx]?.sock?.user) targetIdxs.push(startIdx);
  }

  if (targetIdxs.length === 0)
    return replyDelete(
      ctx,
      `Tidak ada sesi aktif di rentang ${startIdx}-${endIdx}.`,
    );

  const rangeStr =
    startIdx === endIdx ? `${startIdx}` : `${startIdx}-${endIdx}`;
  const walletArg = args[offset]?.toLowerCase();
  const nominalArg = args[offset + 1];

  if (
    walletArg &&
    WALLET_IDS[walletArg] &&
    nominalArg &&
    NOMINAL_IDS[walletArg]?.[nominalArg]
  ) {
    const statusMsg = await replyDelete(
      ctx,
      `⏳ Menukar poin via Sesi ${rangeStr}...`,
    );
    const editMsg = (text, opts = {}) =>
      bot.telegram
        .editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          undefined,
          text,
          { parse_mode: "Markdown", ...opts },
        )
        .catch(() => {});

    if (targetIdxs.length === 1) {
      eksekusiTukar(
        editMsg,
        userId,
        targetIdxs[0],
        userSessions[targetIdxs[0]],
        walletArg,
        nominalArg,
      );
      return;
    } else {
      editMsg(
        `⏳ Sedang mengeksekusi penukaran massal untuk ${targetIdxs.length} sesi...\n_Harap bersabar tunggu WA loading_`,
      );
      (async () => {
        try {
          const promises = targetIdxs.map((idx) =>
            eksekusiTukar(
              () => {},
              userId,
              idx,
              userSessions[idx],
              walletArg,
              nominalArg,
            ),
          );
          await Promise.allSettled(promises);
          editMsg(
            `⏳ Sedang mengupdate sisa poin untuk ${targetIdxs.length} sesi...\n_Harap tunggu sekitar 15 detik untuk konfirmasi AQUA_`,
          );
          await delay(15000);
          const recapPoin = await ambilPoinBatch(targetIdxs, userSessions);
          const walletTitle = WALLET_IDS[walletArg].split("|")[1];
          const nominalTitle = NOMINAL_IDS[walletArg][nominalArg].split("|")[1];
          editMsg(
            `✅ *Penukaran Massal Selesai!*\nTotal: ${targetIdxs.length} sesi (Mulai Sesi ${targetIdxs[0]})\nTujuan: ${walletTitle} - ${nominalTitle}\n\n📊 *Sisa Poin Saat Ini:*${recapPoin}\n\n_Cek riwayat Whatsapp tiap Sesi untuk detail bukti penukaran._`,
          );
        } catch (e) {
          console.error(e);
          editMsg(`❌ Terjadi kesalahan saat penukaran massal.`);
        }
      })();
      return;
    }
  }

  if (walletArg && WALLET_IDS[walletArg]) {
    return tampilPilihNominal(ctx, rangeStr, walletArg);
  }

  return ctx.reply(`[Sesi ${rangeStr}] Pilih dompet digital:`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "GoPay", callback_data: `tukar_wallet:${rangeStr}:gopay` },
          { text: "OVO", callback_data: `tukar_wallet:${rangeStr}:ovo` },
          { text: "DANA", callback_data: `tukar_wallet:${rangeStr}:dana` },
        ],
      ],
    },
  });
});

async function tampilPilihNominal(ctx, rangeStr, wallet) {
  const walletTitle = WALLET_IDS[wallet].split("|")[1];
  const nominals = Object.keys(NOMINAL_IDS[wallet]);
  const rows = [];
  for (let i = 0; i < nominals.length; i += 3) {
    rows.push(
      nominals.slice(i, i + 3).map((n) => ({
        text: `Rp ${n}.000`,
        callback_data: `tukar_nominal:${rangeStr}:${wallet}:${n}`,
      })),
    );
  }
  return ctx.reply(`[Sesi ${rangeStr}] ${walletTitle} — Pilih nominal:`, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function eksekusiTukar(
  editMsg,
  userId,
  idx,
  session,
  walletArg,
  nominalArg,
) {
  const walletId = WALLET_IDS[walletArg];
  const nominalId = NOMINAL_IDS[walletArg][nominalArg];
  const walletTitle = walletId.split("|")[1];
  const nominalTitle = nominalId.split("|")[1];
  const flowToken = session.lastFlowToken || CURRENT_FLOW_TOKEN;
  const sock = session.sock;
  const jid = TARGET_NUMBER + "@s.whatsapp.net";

  logServer(
    userId,
    `Tukar: ${walletTitle} ${nominalTitle} | token: ${flowToken}`,
  );

  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), ms),
      ),
    ]);

  try {
    await withTimeout(sock.sendMessage(jid, { text: "Tukar Poin" }), 15000);
    await delay(2000);
    await withTimeout(sock.sendMessage(jid, { text: "Tukar Poin" }), 15000);
    await delay(3000);

    await withTimeout(
      sock.relayMessage(
        jid,
        {
          interactiveResponseMessage: {
            body: { text: `${walletTitle} - ${nominalTitle}` },
            nativeFlowResponseMessage: {
              name: "flow",
              paramsJson: JSON.stringify({
                flow_token: flowToken,
                item: walletId,
                variant: nominalId,
                screen_type: "EWALLETS_FORM",
              }),
              version: 3,
            },
          },
        },
        { messageId: generateMessageID() },
      ),
      15000,
    );

    logServer(userId, `Form tukar berhasil dikirim.`);
    await editMsg(`✅ *[Sesi ${idx}]* Form penukaran *${walletTitle} - ${nominalTitle}* terkirim!

Tunggu konfirmasi.`);
  } catch (err) {
    logServer(userId, `ERROR tukar: ${err.message}`);
    await editMsg(`❌ *[Sesi ${idx}]* Gagal kirim form: ${err.message}`);
  }
}

// Callback: pilih wallet → tampilkan nominal
bot.action(/^tukar_wallet:([0-9-]+):(.+)$/, async (ctx) => {
  const rangeStr = ctx.match[1];
  const wallet = ctx.match[2];
  await ctx.answerCbQuery();

  const walletTitle = WALLET_IDS[wallet].split("|")[1];
  const nominals = Object.keys(NOMINAL_IDS[wallet]);
  const rows = [];
  for (let i = 0; i < nominals.length; i += 3) {
    rows.push(
      nominals.slice(i, i + 3).map((n) => ({
        text: `Rp ${n}.000`,
        callback_data: `tukar_nominal:${rangeStr}:${wallet}:${n}`,
      })),
    );
  }
  await ctx
    .editMessageText(`[Sesi ${rangeStr}] ${walletTitle} — Pilih nominal:`, {
      reply_markup: { inline_keyboard: rows },
    })
    .catch(() => {});
});

// Callback: pilih nominal → eksekusi tukar
bot.action(/^tukar_nominal:([0-9-]+):(.+):(.+)$/, async (ctx) => {
  const rangeStr = ctx.match[1];
  const wallet = ctx.match[2];
  const nominal = ctx.match[3];
  const userId = ctx.from.id;
  await ctx.answerCbQuery(
    `${WALLET_IDS[wallet]?.split("|")[1]} Rp ${nominal}.000`,
  );

  let parts = rangeStr.split("-");
  let startIdx = parseInt(parts[0], 10);
  let endIdx = parts.length > 1 ? parseInt(parts[1], 10) : startIdx;

  const userSessions = sessions[userId] || {};
  let targetIdxs = [];
  if (startIdx <= endIdx) {
    for (let i = startIdx; i <= endIdx; i++) {
      if (userSessions[i]?.sock?.user) targetIdxs.push(i);
    }
  } else {
    if (userSessions[startIdx]?.sock?.user) targetIdxs.push(startIdx);
  }

  if (targetIdxs.length === 0) {
    return ctx
      .editMessageText(`❌ [Sesi ${rangeStr}] Belum connect!`)
      .catch(() => {});
  }

  const walletTitle = WALLET_IDS[wallet].split("|")[1];
  const nominalTitle = NOMINAL_IDS[wallet][nominal].split("|")[1];

  if (targetIdxs.length === 1) {
    await ctx
      .editMessageText(
        `⏳ *[Sesi ${targetIdxs[0]}]* Menukar poin ke ${walletTitle} - Rp ${nominal}.000...`,
        { parse_mode: "Markdown" },
      )
      .catch(() => {});
    const editMsg = (text, opts = {}) =>
      ctx
        .editMessageText(text, { parse_mode: "Markdown", ...opts })
        .catch(() => {});
    eksekusiTukar(
      editMsg,
      userId,
      targetIdxs[0],
      userSessions[targetIdxs[0]],
      wallet,
      nominal,
    );
    return;
  } else {
    await ctx
      .editMessageText(
        `⏳ *[Sesi ${rangeStr}]* Menukar massal ${targetIdxs.length} sesi ke ${walletTitle} - Rp ${nominal}.000...`,
        { parse_mode: "Markdown" },
      )
      .catch(() => {});
    const editMsg = (text, opts = {}) =>
      ctx
        .editMessageText(text, { parse_mode: "Markdown", ...opts })
        .catch(() => {});

    (async () => {
      try {
        const promises = targetIdxs.map((idx) =>
          eksekusiTukar(
            () => {},
            userId,
            idx,
            userSessions[idx],
            wallet,
            nominal,
          ),
        );
        await Promise.allSettled(promises);
        editMsg(
          `⏳ Sedang mengupdate sisa poin untuk ${targetIdxs.length} sesi...\n_Harap tunggu sekitar 15 detik untuk konfirmasi AQUA..._`,
        );
        await delay(15000);
        const recapPoin = await ambilPoinBatch(targetIdxs, userSessions);
        editMsg(
          `✅ *Penukaran Massal Selesai!*\nTotal: ${targetIdxs.length} sesi (Mulai Sesi ${targetIdxs[0]})\nTujuan: ${walletTitle} - Rp ${nominal}.000\n\n📊 *Sisa Poin Saat Ini:*${recapPoin}`,
        );
      } catch (e) {
        console.error(e);
        editMsg(`❌ Terjadi kesalahan saat penukaran massal.`);
      }
    })();
    return;
  }
});

// Callback Batal Tukar
bot.action(/^tukar_skip:([0-9-]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const rangeStr = ctx.match[1];
  await ctx
    .editMessageText(
      `✅ *[Sesi ${rangeStr}]* Proses selesai. (Status: Batal Tukar Poin)`,
      { parse_mode: "Markdown" },
    )
    .catch(() => {});
});

logServer("SYSTEM", "Bot Jalan...");

// Catch Telegraf internal errors (e.g. timeout) to prevent crash
bot.catch((err, ctx) => {
  console.error(`[BOT ERROR] ${err.message}`);
});

bot.launch({ dropPendingUpdates: true });

async function ambilPoinBatch(targetIdxs, userSessions) {
  const jid = TARGET_NUMBER + "@s.whatsapp.net";
  for (const idx of targetIdxs) {
    userSessions[idx].checkingPoin = true;
    userSessions[idx].poinVal = null;
    try {
      await userSessions[idx].sock.sendMessage(jid, { text: "Menu Utama" });
    } catch (e) {
      userSessions[idx].checkingPoin = false;
      userSessions[idx].poinVal = "timeout";
    }
  }

  let waitStart = Date.now();
  let allDone = false;
  while (!allDone && Date.now() - waitStart < 12000) {
    await delay(1000);
    allDone = true;
    for (const idx of targetIdxs) {
      if (userSessions[idx].checkingPoin) {
        allDone = false;
        break;
      }
    }
  }

  let recap = "";
  for (const idx of targetIdxs) {
    if (userSessions[idx].checkingPoin) {
      userSessions[idx].checkingPoin = false;
      userSessions[idx].poinVal = "timeout";
    }
    const p = userSessions[idx].poinVal;
    recap += `\nSesi ${idx}: ${p && p !== "timeout" ? p + " Poin" : "❌ Timeout"}`;
  }
  return recap;
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// Global error handlers — prevent crash from unhandled promises/exceptions
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err?.message || err);
});
