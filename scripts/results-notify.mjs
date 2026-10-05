// After a push to picks.json: when a round's race results appear for the first time,
// notify every subscribed player with their score and the season standings.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { setupWebPush, readJson, sendToPlayers, removeDeadSubscriptions } from './push.mjs';

const hasRace = results => Boolean(results && results.race && Object.keys(results.race).length);

// The admin saves results in several passes, so only notify once every driver and all bonuses are in.
const isComplete = (results, drivers) => Boolean(results && results.race &&
    drivers.every(d => results.race[d] !== undefined && results.race[d] !== '') &&
    results.polePosition && results.fastestLap && results.dotd);

// Fixes to old races must not look like fresh results.
const isRecent = (picksData, round, now) => {
    const race = (picksData.races || []).find(r => String(r.round) === String(round));
    return Boolean(race) && now - Date.parse(race.date) < 7 * 24 * 3600 * 1000;
};

export function newlyScoredRounds(before, after, drivers, now = Date.now()) {
    return Object.keys(after.raceResults || {})
        .filter(r => isComplete(after.raceResults[r], drivers) && !isComplete((before.raceResults || {})[r], drivers))
        .filter(r => isRecent(after, r, now));
}

// Reuses the app's own scoring code so notifications always match what the app shows.
export function loadScoring(html, picksData) {
    const grab = re => {
        const m = html.match(re);
        if (!m) throw new Error(`Scoring code not found: ${re}`);
        return m[0];
    };
    const code = [
        grab(/const POSITION_POINTS = \{[\s\S]*?\};/),
        grab(/const PENALTY_POINTS = \{[\s\S]*?\};/),
        grab(/const driverTeams = \{[\s\S]*?\};/),
        grab(/^function calculateDriverPoints\([\s\S]*?^}/m),
        grab(/^function calculateTeamPoints\([\s\S]*?^}/m),
        grab(/^function calculatePlayerRoundScore\([\s\S]*?^}/m),
        'globalThis.score = calculatePlayerRoundScore;',
        'globalThis.drivers = Object.keys(driverTeams);'
    ].join('\n');
    const ctx = vm.createContext({ picksData });
    vm.runInContext(code, ctx);
    return {
        drivers: [...ctx.drivers],
        score: (player, round) => {
            const s = ctx.score(player, round);
            return s ? s.grandTotal : null;
        }
    };
}

const fmt = n => (Math.round(n * 10) / 10).toLocaleString('cs-CZ');

export function buildMessages(picksData, round, score) {
    const race = picksData.races.find(r => String(r.round) === String(round));
    const scoredRounds = picksData.races.filter(r => hasRace((picksData.raceResults || {})[String(r.round)]));
    const players = picksData.players || [];

    const roundScores = players.map(p => ({ p, pts: score(p, round) }))
        .filter(x => x.pts !== null)
        .sort((a, b) => b.pts - a.pts);
    const season = players.map(p => ({ p, total: scoredRounds.reduce((s, r) => s + (score(p, r.round) || 0), 0) }))
        .sort((a, b) => b.total - a.total);
    const best = roundScores[0];

    return Object.fromEntries(players.map(p => {
        const mine = roundScores.findIndex(x => x.p === p);
        const pos = season.findIndex(x => x.p === p) + 1;
        const total = season[pos - 1].total;
        const me = mine >= 0
            ? `Ty: ${fmt(roundScores[mine].pts)} b (${mine + 1}. v kole) · celkově ${pos}. místo, ${fmt(total)} b`
            : `Tentokrát bez sestavy · celkově ${pos}. místo, ${fmt(total)} b`;
        const top = best ? `\nNejvíc bodů: ${best.p} (${fmt(best.pts)} b)` : '';
        return [p, { title: `🏆 Výsledky: ${race ? race.name : 'R' + round}`, body: me + top, tag: `results-${round}` }];
    }));
}

async function main() {
    const after = JSON.parse(readFileSync(new URL('../data/picks.json', import.meta.url), 'utf8'));
    const beforeSha = process.env.BEFORE_SHA;
    let before = {};
    if (beforeSha && !/^0+$/.test(beforeSha)) {
        try {
            before = JSON.parse(execSync(`git show ${beforeSha}:data/picks.json`, { encoding: 'utf8', maxBuffer: 50e6 }));
        } catch (e) {
            console.log('Previous picks.json not available:', e.message);
        }
    }

    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const { drivers, score } = loadScoring(html, after);
    const rounds = newlyScoredRounds(before, after, drivers);
    if (!rounds.length) {
        console.log('No newly completed race results.');
        return;
    }

    setupWebPush();
    const subs = (await readJson('data/subscriptions.json')) || {};
    const dead = [];
    for (const round of rounds) {
        const messages = buildMessages(after, round, score);
        console.log(`Results for round ${round}:`, JSON.stringify(messages, null, 1));
        await sendToPlayers(subs, Object.keys(subs).filter(p => messages[p]), p => messages[p], dead);
    }
    await removeDeadSubscriptions(dead);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => { console.error(e); process.exit(1); });
}
