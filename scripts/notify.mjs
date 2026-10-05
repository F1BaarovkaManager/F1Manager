// Sends qualifying reminders: T-30 min to everyone, T-5 min only to players without a pick.
// Runs from GitHub Actions every ~15 min; the run that catches an upcoming session waits for the exact times.
import webpush from 'web-push';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = process.env.GITHUB_REPOSITORY || 'F1BaarovkaManager/F1Manager';
const TOKEN = process.env.GITHUB_TOKEN;
const VAPID_PUBLIC_KEY = 'BLEl-IJTCRtHtR7kekoRGfESPp00tPgYVyUdRSowJ7LYCiaazlZqzhOhmjjU_clvvmcFqQ1UviTLK7kWgMnWaYg';
const MIN = 60 * 1000;
const LOOKAHEAD = 80 * MIN;

export function findUpcomingSession(races, now) {
    return races
        .filter(r => !r.cancelled && r.qualiStart)
        .map(r => ({ ...r, start: Date.parse(r.qualiStart) }))
        .sort((a, b) => a.start - b.start)
        .find(r => r.start - 5 * MIN > now && r.start - 30 * MIN - now <= LOOKAHEAD);
}

async function readJson(path) {
    if (!TOKEN) return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
    const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.raw+json' }
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GitHub ${path}: ${resp.status}`);
    return resp.json();
}

async function removeDeadSubscriptions(endpoints) {
    if (!endpoints.length || !TOKEN) return;
    const url = `https://api.github.com/repos/${REPO}/contents/data/subscriptions.json`;
    const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' };
    for (let attempt = 1; attempt <= 4; attempt++) {
        const meta = await (await fetch(url, { headers })).json();
        const data = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
        for (const p of Object.keys(data)) {
            data[p] = data[p].filter(s => !endpoints.includes(s.endpoint));
            if (!data[p].length) delete data[p];
        }
        const resp = await fetch(url, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
                message: 'Notifications: remove expired devices',
                content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
                sha: meta.sha
            })
        });
        if (resp.ok) return;
        if (resp.status !== 409 && resp.status !== 422) throw new Error(`Cleanup failed: ${resp.status}`);
    }
}

async function sendToPlayers(subs, players, makePayload, dead) {
    for (const player of players) {
        for (const sub of subs[player] || []) {
            try {
                await webpush.sendNotification(sub, JSON.stringify(makePayload(player)), { TTL: 600, urgency: 'high' });
                console.log(`sent -> ${player}`);
            } catch (e) {
                console.log(`failed -> ${player}: ${e.statusCode || e.message}`);
                if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
            }
        }
    }
}

const sleepUntil = t => new Promise(r => setTimeout(r, Math.max(0, t - Date.now())));
const hasPick = (picks, player, round) => Boolean(picks.picks?.[player]?.[String(round)]);

async function main() {
    webpush.setVapidDetails('https://f1baarovkamanager.github.io/F1Manager/', VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const subs = (await readJson('data/subscriptions.json')) || {};
    const dead = [];

    const testPlayer = (process.env.TEST_PLAYER || '').trim();
    if (testPlayer) {
        const players = testPlayer.toLowerCase() === 'all' ? Object.keys(subs) : [testPlayer];
        if (!players.some(p => subs[p])) console.log(`No devices registered for "${testPlayer}". Registered: ${Object.keys(subs).join(', ') || 'none'}`);
        await sendToPlayers(subs, players, () => ({ title: 'Test 🏁', body: 'Upozornění fungují!', tag: 'test' }), dead);
        await removeDeadSubscriptions(dead);
        return;
    }

    const session = findUpcomingSession((await readJson('data/picks.json')).races, Date.now());
    if (!session) {
        console.log('No qualifying session in the next window.');
        return;
    }
    const label = session.qualiName || 'Kvalifikace';
    console.log(`Upcoming: ${session.name} – ${label} at ${session.qualiStart}`);

    await sleepUntil(session.start - 30 * MIN);
    const minutesLeft = Math.round((session.start - Date.now()) / MIN);
    if (minutesLeft >= 10) {
        const picks = await readJson('data/picks.json');
        await sendToPlayers(subs, Object.keys(subs), player => ({
            title: `🏁 ${session.name}`,
            body: hasPick(picks, player, session.round)
                ? `${label} začíná za ${minutesLeft} minut. Sestavu máš hotovou ✅`
                : `${label} začíná za ${minutesLeft} minut a ještě nemáš postaveno!`,
            tag: `quali-${session.round}`
        }), dead);
    }

    await sleepUntil(session.start - 5 * MIN);
    const picks = await readJson('data/picks.json');
    const missing = Object.keys(subs).filter(p => !hasPick(picks, p, session.round));
    console.log(`Without pick: ${missing.join(', ') || 'nobody'}`);
    await sendToPlayers(subs, missing, () => ({
        title: `⏰ ${session.name} – posledních 5 minut!`,
        body: `${label} začíná za 5 minut a ty ještě nemáš postaveno!`,
        tag: `quali-${session.round}`
    }), dead);

    await removeDeadSubscriptions(dead);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => { console.error(e); process.exit(1); });
}
