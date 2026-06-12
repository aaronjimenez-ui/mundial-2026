import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL = "jimenezaaron5@gmail.com";
const ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "mnd26cron-be84f946f3623b9c";

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

  // Use total match clock (seconds) — cumulative, not per-half. Accounts for stopped clock.
  const period: number = comp.status.period || 1;
  const clockSeconds: number = comp.status.clock || 0;
  const mins = Math.floor(clockSeconds / 60);

  if (period >= 3) {
    return `Prórroga · ${mins}'`;
  }

  if (period === 2) {
    return `2T · ${mins}'`;
  }

  return `1T · ${mins}'`;
}

async function syncScores() {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const apiRes = await fetch(ESPN_URL);
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

    const isFinished = state === "post";
    const homeScore = parseInt(home?.score ?? "0") || 0;
    const awayScore = parseInt(away?.score ?? "0") || 0;
    const matchMinute = getMatchMinute(comp, state);

    // Try exact match first, then fuzzy within ±5 minutes
    let dbMatch: any = null;

    const exactResult = await supabase
      .from("mundial_matches")
      .select("id, is_finished, home_score, away_score, match_minute")
      .eq("match_date", matchDate)
      .maybeSingle();

    if (!exactResult.error && exactResult.data) {
      dbMatch = exactResult.data;
    } else {
      const windowStart = new Date(new Date(event.date).getTime() - 5 * 60 * 1000).toISOString();
      const windowEnd   = new Date(new Date(event.date).getTime() + 5 * 60 * 1000).toISOString();

      const fuzzyResult = await supabase
        .from("mundial_matches")
        .select("id, is_finished, home_score, away_score, match_minute, home_team, away_team")
        .gte("match_date", windowStart)
        .lte("match_date", windowEnd)
        .maybeSingle();

      if (!fuzzyResult.error && fuzzyResult.data) {
        dbMatch = fuzzyResult.data;
        errors.push(`fuzzyMatch: ${event.name} -> ${dbMatch.home_team} vs ${dbMatch.away_team}`);
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
