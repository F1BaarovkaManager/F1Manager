import webpush from 'web-push';
import { readFileSync } from 'node:fs';

const REPO = process.env.GITHUB_REPOSITORY || 'F1BaarovkaManager/F1Manager';
const TOKEN = process.env.GITHUB_TOKEN;
const VAPID_PUBLIC_KEY = 'BLEl-IJTCRtHtR7kekoRGfESPp00tPgYVyUdRSowJ7LYCiaazlZqzhOhmjjU_clvvmcFqQ1UviTLK7kWgMnWaYg';

export function setupWebPush() {
    webpush.setVapidDetails('https://f1baarovkamanager.github.io/F1Manager/', VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

export async function readJson(path) {
    if (!TOKEN) return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
    const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.raw+json' }
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GitHub ${path}: ${resp.status}`);
    return resp.json();
}

export async function sendToPlayers(subs, players, makePayload, dead) {
    for (const player of players) {
        for (const sub of subs[player] || []) {
            try {
                await webpush.sendNotification(sub, JSON.stringify(makePayload(player)), { TTL: 3600, urgency: 'high' });
                console.log(`sent -> ${player}`);
            } catch (e) {
                console.log(`failed -> ${player}: ${e.statusCode || e.message}`);
                if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
            }
        }
    }
}

export async function removeDeadSubscriptions(endpoints) {
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
