import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET')!

Deno.serve(async (req) => {
  // Verificar secret del cron
  const auth = req.headers.get('Authorization')
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  webpush.setVapidDetails(
    'mailto:aaron.jimenez@nubox.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  )

  // Buscar próximo partido en las siguientes 2 horas
  const now = new Date()
  const in2h = new Date(now.getTime() + 2 * 60 * 60 * 1000)

  const { data: nextMatch, error: matchErr } = await sb
    .from('mundial_matches')
    .select('id, home_team, away_team, match_date')
    .eq('status', 'pending')
    .gte('match_date', now.toISOString())
    .lte('match_date', in2h.toISOString())
    .order('match_date', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (matchErr) return new Response(JSON.stringify({ error: matchErr.message }), { status: 500 })
  if (!nextMatch) return new Response(JSON.stringify({ sent: 0, reason: 'no_upcoming_match' }))

  // Usuarios que YA apostaron en este partido
  const { data: existing } = await sb
    .from('mundial_predictions')
    .select('user_id')
    .eq('match_id', nextMatch.id)

  const alreadyBet = new Set((existing || []).map((p: { user_id: string }) => p.user_id))

  // Todas las suscripciones activas
  const { data: allSubs } = await sb
    .from('push_subscriptions')
    .select('id, user_id, subscription')

  const pending = (allSubs || []).filter((s: { user_id: string }) => !alreadyBet.has(s.user_id))

  if (pending.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: 'all_users_have_bet', match: `${nextMatch.home_team} vs ${nextMatch.away_team}` }))
  }

  // Calcular tiempo restante
  const msLeft = new Date(nextMatch.match_date).getTime() - now.getTime()
  const minsLeft = Math.round(msLeft / 60000)
  const timeLabel = minsLeft >= 60 ? `${Math.round(minsLeft / 60)}h` : `${minsLeft} min`

  const payload = JSON.stringify({
    title: '⚽ ¡Falta tu apuesta!',
    body: `${nextMatch.home_team} vs ${nextMatch.away_team} empieza en ${timeLabel}`,
    matchId: nextMatch.id,
    url: '/'
  })

  let sent = 0
  const expired: string[] = []

  for (const sub of pending) {
    try {
      await webpush.sendNotification(sub.subscription, payload)
      sent++
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode
      // 410 = suscripción expirada o revocada por el browser
      if (statusCode === 410 || statusCode === 404) {
        expired.push(sub.id)
      }
    }
  }

  // Limpiar suscripciones expiradas
  if (expired.length > 0) {
    await sb.from('push_subscriptions').delete().in('id', expired)
  }

  return new Response(
    JSON.stringify({
      sent,
      expired: expired.length,
      match: `${nextMatch.home_team} vs ${nextMatch.away_team}`,
      timeLabel
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})
