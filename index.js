const { Telegraf } = require('telegraf');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, delay, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// --- KONFIGURASI ---
const BOT_TOKEN = '8490657007:AAHvuNCrAZyK56WCPQKkUXjdqzl5EOpHIew'; 
const TARGET_NUMBER = '628111599388'; // Nomor AQUA
const DELAY_ANTAR_KODE = 8000; 
const DELAY_RESPON_BOT = 2000;  

const bot = new Telegraf(BOT_TOKEN);
const sessions = {}; 

// --- UTILS: LOGGER ---
function logServer(userId, msg) {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    console.log(`[${time}] [User: ${userId}] 👉 ${msg}`);
}

// --- FUNGSI HAPUS SESI (Hanya dipanggil manual via /logout) ---
async function deleteSession(userId) {
    if (sessions[userId]) {
        try { sessions[userId].sock.end(undefined); } catch (e) {}
        delete sessions[userId];
    }
    const sessionDir = path.join('sessions', `user_${userId}`);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logServer(userId, '✅ Folder sesi berhasil dihapus.');
    }
}

// --- FUNGSI UTAMA: SESSION MANAGER ---
async function startSession(userId, ctx = null) {
    // Pastikan folder induk sessions ada
    if (!fs.existsSync('sessions')) fs.mkdirSync('sessions');

    const sessionPath = path.join('sessions', `user_${userId}`);
    
    // Pastikan folder user ada SEBELUM auth state dimuat
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        // Browser Ubuntu/Chrome agar dianggap Desktop (lebih stabil)
        browser: Browsers.ubuntu("Chrome"), 
        syncFullHistory: false,
        // Tambahkan timeout agar tidak cepat putus
        connectTimeoutMs: 60000, 
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250
    });

    sessions[userId] = { sock, qr: null, lastButtonId: null };

    // FIX CRASH: Cek folder sebelum save creds
    sock.ev.on('creds.update', async () => {
        if (fs.existsSync(sessionPath)) {
            await saveCreds();
        }
    });

    // 1. LISTENER PESAN
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return; 

        const sender = msg.key.remoteJid;
        
        if (sender && sender.includes(TARGET_NUMBER)) {
            // Deteksi Tombol
            const buttons = msg.message.buttonsMessage?.buttons || 
                            msg.message.templateMessage?.hydratedTemplate?.hydratedButtons || 
                            msg.message.interactiveMessage?.body?.nativeFlowMessage?.buttons;

            if (buttons) {
                buttons.forEach(btn => {
                    const text = btn.buttonText?.displayText || btn.quickReplyButton?.displayText || "";
                    const id = btn.buttonId || btn.quickReplyButton?.id;
                    if (text.toLowerCase().includes('masukkan kode')) {
                        if(sessions[userId]) sessions[userId].lastButtonId = id;
                        logServer(userId, `Tombol Ditemukan! ID: ${id}`);
                    }
                });
            }

            // Forward Pesan ke Telegram
            const textMessage = msg.message.conversation || 
                                msg.message.extendedTextMessage?.text || 
                                msg.message.imageMessage?.caption ||
                                null;

            if (textMessage) {
                logServer(userId, `Pesan Masuk: "${textMessage.substring(0, 30)}..."`);
                try {
                    await bot.telegram.sendMessage(userId, `📩 *AQUA:*\n${textMessage}`, { parse_mode: 'Markdown' });
                } catch (err) {}
            }
        }
    });

    // 2. KONEKSI UPDATE (BAGIAN YANG DIPERBAIKI)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            sessions[userId].qr = qr;
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            logServer(userId, `Koneksi Terputus (Code: ${statusCode}). Reconnect: ${shouldReconnect}`);

            // LOGIKA BARU: Jangan hapus folder otomatis!
            // Hanya reconnect jika memungkinkan.
            if (shouldReconnect) {
                // Delay sedikit sebelum reconnect biar gak spamming
                setTimeout(() => startSession(userId), 3000);
            } else {
                // Jika benar-benar Logout (401), biarkan user login ulang manual
                logServer(userId, 'Sesi berakhir (Logged Out). Silakan /qr atau /pairing lagi.');
                if(sessions[userId]) delete sessions[userId].sock;
                // JANGAN deleteSession(userId) disini untuk menghindari crash file lock
                try {
                    await bot.telegram.sendMessage(userId, '⚠️ WhatsApp terputus (Logged Out). Ketik /qr atau /pairing untuk login ulang.');
                } catch(e){}
            }
        } else if (connection === 'open') {
            logServer(userId, '✅ WhatsApp Terhubung!');
            if(sessions[userId]) sessions[userId].qr = null;
            
            // Notif cuma sekali saat connect
            try { await bot.telegram.sendMessage(userId, '✅ *WhatsApp Berhasil Terhubung!*', { parse_mode: 'Markdown' }); } catch(e){}
        }
    });
}

// --- RESTORE SESSION ---
(async () => {
    try {
        await bot.telegram.setMyCommands([
            { command: 'start', description: 'Mulai Bot' },
            { command: 'qr', description: 'Login via Scan QR' },
            { command: 'pairing', description: 'Login via Kode (Nomor HP)' },
            { command: 'kode', description: 'Kirim List Kode' },
            { command: 'logout', description: 'Hapus Sesi' }
        ]);
    } catch (e) {}

    if (fs.existsSync('sessions')) {
        const files = fs.readdirSync('sessions');
        for (const file of files) {
            if (file.startsWith('user_')) {
                const userId = file.replace('user_', '');
                console.log(`🔄 Restore User: ${userId}`);
                await startSession(userId);
            }
        }
    }
})();

// --- COMMANDS ---

bot.start((ctx) => ctx.reply('🤖 *Bot Auto-Aqua Ready.*\n\n1. /pairing 628xxx (Rekomendasi)\n2. /qr (Scan)', { parse_mode: 'Markdown' }));

bot.command('qr', async (ctx) => {
    const userId = ctx.from.id;
    if (!sessions[userId]) {
        await ctx.reply('⏳ Menyiapkan sesi...');
        await startSession(userId, ctx);
        await delay(2000); 
    }
    if (sessions[userId]?.sock?.user) return ctx.reply('✅ Sudah connect!');

    if (sessions[userId]?.qr) {
        const buffer = await QRCode.toBuffer(sessions[userId].qr);
        await ctx.replyWithPhoto({ source: buffer });
    } else {
        ctx.reply('⏳ Tunggu sebentar...');
    }
});

bot.command('pairing', async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ');
    let phoneNumber = args[1];

    if (!phoneNumber) return ctx.reply('⚠️ Contoh: `/pairing 62812345678`', { parse_mode: 'Markdown' });
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

    // Pastikan sesi jalan dulu
    if (!sessions[userId]) {
        await ctx.reply('🚀 Menyiapkan engine...');
        await startSession(userId);
        await delay(5000); // Wajib delay agak lama untuk inisialisasi awal
    }

    const session = sessions[userId];
    if (session.sock?.user) return ctx.reply('✅ WhatsApp sudah connect!');

    try {
        await ctx.reply('⏳ Meminta kode pairing...');
        // Request code
        const code = await session.sock.requestPairingCode(phoneNumber);
        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
        
        await ctx.reply(`🔐 *Kode Pairing:*\n\n\`${formattedCode}\`\n\nMasukkan di menu "Tautkan dengan Nomor Telepon".`, { parse_mode: 'Markdown' });
    } catch (err) {
        logServer(userId, `Gagal Pairing: ${err.message}`);
        // Jika gagal, restart sesi biar fresh
        delete sessions[userId]; 
        ctx.reply('❌ Gagal. Coba lagi dalam 5 detik.');
    }
});

bot.command('logout', async (ctx) => {
    await ctx.reply('Proses logout...');
    await deleteSession(ctx.from.id);
    await ctx.reply('👋 Sesi dihapus.');
});

bot.command('kode', async (ctx) => {
    const userId = ctx.from.id;
    const userSession = sessions[userId];

    if (!userSession || !userSession.sock?.user) {
        return ctx.reply('❌ WA belum connect!');
    }

    const rawText = ctx.message.text.replace('/kode', '').trim();
    if (!rawText) return ctx.reply('⚠️ Mana kodenya?');
    
    const kodeList = rawText.split('\n').filter(k => k.trim() !== '');
    const sock = userSession.sock;
    const jid = TARGET_NUMBER + '@s.whatsapp.net';
    
    ctx.reply(`🚀 Otw kirim ${kodeList.length} kode...`);
    logServer(userId, `Start Job: ${kodeList.length} kode`);

    for (let i = 0; i < kodeList.length; i++) {
        const kode = kodeList[i].trim();
        try {
            await sock.sendMessage(jid, { text: 'Masukkan Kode Unik' });
            await delay(DELAY_RESPON_BOT); 
            await sock.sendMessage(jid, { text: kode });
            logServer(userId, `Kode ${kode} sent.`);
            if (i < kodeList.length - 1) await delay(DELAY_ANTAR_KODE);
        } catch (err) {
            logServer(userId, `ERROR: ${err.message}`);
        }
    }
    ctx.reply('✅ Selesai!');
});

logServer('SYSTEM', 'Bot Jalan...');
bot.launch({ dropPendingUpdates: true });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));