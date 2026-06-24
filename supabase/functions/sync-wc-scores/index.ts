import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL = "jimenezaaron5@gmail.com";
const CRON_SECRET = "mnd26cron-be84f946f3623b9c";

function getEspnUrl(): string {
  const d = new Date();
  const yyyymmdd = d.getUTCFullYear().toString()
    + String(d.getUTCMonth() + 1).padStart(2, '0')
    + String(d.getUTCDate()).padStart(2, '0');
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${yyyymmdd}`;
}

function getMatchMinute(comp: any, state: string): string | null {
  if (state !== 'in') return null;

  const statusName: string = comp.status.type.name || '';
  const description: string = comp.status.type.description || '';

  if (statusName.includes('HALFTIME') || description.toLowerCase().includes('halftime')) {
    return 'Descanso';
  }

  if (statusName.includes('SHOOTOUT') || statusName.includes('PENALTY')) {
    return 'Penales';
  }

  const period: number = comp.status.period || 1;
  const displayClock: string = comp.status.displayClock || '';

  // During stoppage time ESPN freezes `clock` at 2700/5400s but `displayClock` shows "45'+3'" or "90'+8'"
  // During regular play use clock/60 (more stable than displayClock string)
  let minuteStr: string;
  if (displayClock.includes('+')) {
    // Stoppage: "45'+3'" → strip all apostrophes → "45+3" → append "'" → "45+3'"
    minuteStr = displayClock.replace(/'/g, '') + "'";
  } else {
    minuteStr = `${Math.floor((comp.status.clock || 0) / 60)}'`;
  }

  if (period >= 3) return `Prórroga · ${minuteStr}`;
  if (period === 2) return `2T · ${minuteStr}`;
  return `1T · ${minuteStr}`;
}

// ESPN English team name → DB Spanish name
const ESPN_TO_DB: Record<string, string> = {
  'Switzerland': 'Suiza', 'Germany': 'Alemania', 'Netherlands': 'Países Bajos',
  'Morocco': 'Marruecos', 'South Africa': 'Sudáfrica', 'Saudi Arabia': 'Arabia Saudita',
  'South Korea': 'Corea del Sur', 'Czech Republic': 'Rep. Checa', 'Czechia': 'Rep. Checa',
  'DR Congo': 'Rep. D. Congo', 'Congo, DR': 'Rep. D. Congo', 'Democratic Republic of Congo': 'Rep. D. Congo',
  'New Zealand': 'Nueva Zelanda', 'Ivory Coast': 'Costa de Marfil', "Cote d'Ivoire": 'Costa de Marfil',
  'Belgium': 'Bélgica', 'Sweden': 'Suecia', 'Tunisia': 'Túnez', 'France': 'Francia',
  'Brazil': 'Brasil', 'Scotland': 'Escocia', 'Mexico': 'México', 'Japan': 'Japón',
  'Iran': 'Irán', 'Panama': 'Panamá', 'Turkey': 'Türkiye',
  'Bosnia and Herzegovina': 'Bosnia y Herz.', 'Bosnia & Herzegovina': 'Bosnia y Herz.',
  'Bosnia-Herzegovina': 'Bosnia y Herz.', 'Denmark': 'Dinamarca', 'Curacao': 'Curazao',
  'Algeria': 'Argelia', 'Iraq': 'Irak', 'Haiti': 'Haití', 'Croatia': 'Croacia',
  'Spain': 'España', 'Norway': 'Noruega', 'Paraguay': 'Paraguay', 'Egypt': 'Egipto',
  'Uzbekistan': 'Uzbekistán', 'Cape Verde': 'Cabo Verde', 'USA': 'Estados Unidos',
  'United States': 'Estados Unidos', 'England': 'Inglaterra', 'Canada': 'Canadá',
};

function toDbName(espnName: string): string {
  return ESPN_TO_DB[espnName] || espnName;
}

function pickFromCandidates(candidates: any[], espnHome: string, espnAway: string): any {
  const dbHome = toDbName(espnHome);
  const dbAway = toDbName(espnAway);
  return candidates.find((m: any) => m.home_team === dbHome && m.away_team === dbAway)
    || candidates.find((m: any) => m.home_team === dbAway && m.away_team === dbHome)
    || candidates.find((m: any) => m.home_team === dbHome || m.away_team === dbAway || m.home_team === dbAway || m.away_team === dbHome)
    || null;
}

async function syncScores() {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const apiRes = await fetch(getEspnUrl());
  if (!apiRes.ok) return { error: "ESPN API error", status: apiRes.status };

  const data = await apiRes.json();
  const events: any[] = data.events || [];

  const relevant = events.filter((e: any) => e.competitions[0].status.type.state !== "pre");
  if (relevant.length === 0) return { success: true, totalToday: events.length, updated: 0, skipped: events.length, notFound: 0, errors: [] };

  let updated = 0, skipped = 0, notFound = 0;
  const errors: string[] = [];

  for (const event of relevant) {
    const comp = event.competitions[0];
    const state: string = comp.status.type.state;
    const matchDate = new Date(event.date).toISOString();

    const home = comp.competitors.find((c: any) => c.homeAway === "home");
    const away = comp.competitors.find((c: any) => c.homeAway === "away");
    const espnHome: string = home?.team?.displayName || home?.team?.name || '';
    const espnAway: string = away?.team?.displayName || away?.team?.name || '';

    const isFinished = state === "post";
    const homeScore = parseInt(home?.score ?? "0") || 0;
    const awayScore = parseInt(away?.score ?? "0") || 0;
    const matchMinute = getMatchMinute(comp, state);

    // Lookup: exact by date → if multiple, disambiguate by team name → fuzzy window fallback
    let dbMatch: any = null;

    const exactResult = await supabase
      .from("mundial_matches")
      .select("id, is_finished, home_score, away_score, match_minute, home_team, away_team")
      .eq("match_date", matchDate);

    if (!exactResult.error && exactResult.data) {
      if (exactResult.data.length === 1) {
        dbMatch = exactResult.data[0];
      } else if (exactResult.data.length > 1) {
        // Concurrent matches — disambiguate by team name
        dbMatch = pickFromCandidates(exactResult.data, espnHome, espnAway);
        if (dbMatch) errors.push(`multiMatch: ${event.name} -> ${dbMatch.home_team} vs ${dbMatch.away_team}`);
      }
    }

    if (!dbMatch) {
      const windowStart = new Date(new Date(event.date).getTime() - 5 * 60 * 1000).toISOString();
      const windowEnd   = new Date(new Date(event.date).getTime() + 5 * 60 * 1000).toISOString();

      const fuzzyResult = await supabase
        .from("mundial_matches")
        .select("id, is_finished, home_score, away_score, match_minute, home_team, away_team")
        .gte("match_date", windowStart)
        .lte("match_date", windowEnd);

      if (!fuzzyResult.error && fuzzyResult.data && fuzzyResult.data.length > 0) {
        dbMatch = fuzzyResult.data.length === 1
          ? fuzzyResult.data[0]
          : pickFromCandidates(fuzzyResult.data, espnHome, espnAway);
        if (dbMatch) errors.push(`fuzzyMatch: ${event.name} -> ${dbMatch.home_team} vs ${dbMatch.away_team}`);
      }
    }

    if (!dbMatch) { notFound++; errors.push(`notFound: ${event.name} (${matchDate})`); continue; }

    if (
      dbMatch.is_finished === isFinished &&
      dbMatch.home_score === homeScore &&
      dbMatch.away_score === awayScore &&
      dbMatch.match_minute === matchMinute
    ) {
      skipped++; continue;
    }

    const { error: updateErr } = await supabase
      .from("mundial_matches")
      .update({
        is_finished: isFinished,
        home_score: homeScore,
        away_score: awayScore,
        match_minute: isFinished ? null : matchMinute,
      })
      .eq("id", dbMatch.id);

    if (updateErr) errors.push(`${event.name}: ${updateErr.message}`);
    else updated++;
  }

  return { success: true, totalToday: events.length, relevant: relevant.length, updated, skipped, notFound, errors };
}

Deno.serve(async (req: Request) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const isCronCall = token === CRON_SECRET;

  if (!isCronCall) {
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user || user.email !== ADMIN_EMAIL) {
      return new Response(JSON.stringify({ error: "Admin only" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  }

  const result = await syncScores();
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
});
