// Sends qualifying reminders: T-30 min to everyone, T-5 min only to players without a pick.
// Runs from GitHub Actions every ~15 min; the run that catches an upcoming session waits for the exact times.
import { pathToFileURL } from 'node:url';
import { setupWebPush, readJson, sendToPlayers, removeDeadSubscriptions } from './push.mjs';

const MIN = 60 * 1000;
const LOOKAHEAD = 80 * MIN;

export function findUpcomingSession(races, now) {
    return races
        .filter(r => !r.cancelled && r.qualiStart)
        .map(r => ({ ...r, start: Date.parse(r.qualiStart) }))
        .sort((a, b) => a.start - b.start)
        .find(r => r.start - 5 * MIN > now && r.start - 30 * MIN - now <= LOOKAHEAD);
}

const sleepUntil = t => new Promise(r => setTimeout(r, Math.max(0, t - Date.now())));
const hasPick = (picks, player, round) => Boolean(picks.picks?.[player]?.[String(round)]);

async function main() {
    setupWebPush();
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
