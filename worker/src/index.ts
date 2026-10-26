interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

interface Env {
  OPENROUTER_API_KEY?: string
  ALLOWED_ORIGINS?: string
  APP_URL?: string
  RATE_LIMITER?: RateLimitBinding
}

type RecipeFilters = { cuisine?: string; diet?: string; maxMinutes?: string | number; expiringOnly?: boolean }
type PantryItem = { name: string; quantity: number; unit: string; location: string; expiryDate: string; daysUntilExpiry: number }
type RequestBody = { question?: unknown; items?: unknown; offset?: unknown; filters?: unknown; localRecipeTitles?: unknown }
type OpenRouterResponse = { choices?: Array<{ message?: { content?: string | null } }> }

const MAX_QUESTION_LENGTH = 500
const MAX_BODY_BYTES = 24_000
const MAX_ITEMS = 50
const MAX_TITLES = 50
const MAX_RESPONSE_TOKENS = 500
const ROUTE = '/api/ask-recipe'

function allowedOrigins(env: Env) {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)
}

function isConfigured(env: Env) {
  const origins = allowedOrigins(env)
  return Boolean(env.OPENROUTER_API_KEY && env.RATE_LIMITER && origins.length && origins.every((origin) => !origin.includes('YOUR-PAGES-DOMAIN.example')))
}

function corsHeaders(origin: string | null, env: Env) {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (origin && allowedOrigins(env).includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function json(body: unknown, status: number, origin: string | null, env: Env) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin, env) } })
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function text(value: unknown, max: number) { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function validNumber(value: unknown, fallback: number) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }

function sanitiseItems(value: unknown): PantryItem[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_ITEMS).flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') return []
    const days = validNumber(item.daysUntilExpiry, 999)
    return [{ name: text(item.name, 80), quantity: Math.max(0, Math.min(999, validNumber(item.quantity, 1))), unit: text(item.unit, 20), location: text(item.location, 20), expiryDate: text(item.expiryDate, 20), daysUntilExpiry: Math.max(-3650, Math.min(3650, days)) }]
  })
}

function sanitiseFilters(value: unknown): RecipeFilters {
  if (!isRecord(value)) return {}
  const cuisine = text(value.cuisine, 20)
  const diet = text(value.diet, 30)
  const maxMinutes = typeof value.maxMinutes === 'number' || typeof value.maxMinutes === 'string' ? value.maxMinutes : 'all'
  return { cuisine, diet, maxMinutes, expiringOnly: value.expiringOnly === true }
}

function preferenceText(filters: RecipeFilters) {
  const cuisine = filters.cuisine && filters.cuisine !== 'all' ? `${filters.cuisine} cuisine` : 'any cuisine'
  const diet = filters.diet && filters.diet !== 'all' ? filters.diet : 'any dietary style'
  const time = filters.maxMinutes && filters.maxMinutes !== 'all' ? `at most ${filters.maxMinutes} minutes` : 'any cooking time'
  return `${cuisine}; ${diet}; ${time}; ${filters.expiringOnly ? 'prioritise ingredients expiring within five days' : 'use expiry urgency when it helps'}`
}

async function handleRecipeRequest(request: Request, env: Env, origin: string | null) {
  const limiter = env.RATE_LIMITER
  if (!isConfigured(env) || !limiter) return json({ error: 'Ask AI is not configured yet. Local recipe search is still available.' }, 503, origin, env)
  if (origin && !allowedOrigins(env).includes(origin)) return json({ error: 'This app origin is not allowed to use the recipe service.' }, 403, origin, env)

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const limited = await limiter.limit({ key: ip })
  if (!limited.success) return json({ error: 'Ask AI is temporarily busy. Try again later or use local recipe search.' }, 429, origin, env)

  const contentLength = Number(request.headers.get('Content-Length') || 0)
  if (contentLength > MAX_BODY_BYTES) return json({ error: 'That recipe request is too large.' }, 413, origin, env)

  let body: RequestBody
  try {
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: 'That recipe request is too large.' }, 413, origin, env)
    body = JSON.parse(raw) as RequestBody
  } catch { return json({ error: 'The recipe request was not valid JSON.' }, 400, origin, env) }

  const question = text(body.question, MAX_QUESTION_LENGTH)
  if (!question) return json({ error: 'Type a cooking question first.' }, 400, origin, env)
  const items = sanitiseItems(body.items)
  const filters = sanitiseFilters(body.filters)
  const offset = Math.max(-3650, Math.min(3650, validNumber(body.offset, 0)))
  const titles = Array.isArray(body.localRecipeTitles) ? body.localRecipeTitles.filter((title): title is string => typeof title === 'string').map((title) => title.trim().slice(0, 100)).filter(Boolean).slice(0, MAX_TITLES) : []
  const inventory = items.map((item) => ({ ...item, daysUntilExpiry: item.daysUntilExpiry + offset }))
  const prompt = [
  `User question: ${question}`,
  `Preferences: ${preferenceText(filters)}`,
  'Inventory context. Use this inventory to identify ingredients the user already has.',
  'You may answer the user even when requested ingredients are missing from the inventory.',
  'Clearly separate ingredients into available, missing, and expired.',
  'Never recommend using an expired item. Mark expired items as unsafe to use and advise discarding them according to normal food-safety guidance.',
  'Do not claim that an ingredient is available unless it appears in the inventory.',
  'If the user asks for a recipe using ingredients that are not in the inventory, still provide the recipe and list those ingredients under "Missing ingredients".',
  'Prefer available ingredients when practical, but do not restrict the answer to available ingredients unless the user explicitly asks for pantry-only recipes.',
  JSON.stringify(inventory),
  `Built-in recipe titles for grounded options: ${titles.join(', ')}`,
].join('\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  let upstream: Response
  try {
    upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', ...(env.APP_URL ? { 'HTTP-Referer': env.APP_URL, 'X-OpenRouter-Title': 'ExpiryGuard' } : {}) },
      body: JSON.stringify({
        model: 'openrouter/free',
        temperature: 0.35,
        max_tokens: MAX_RESPONSE_TOKENS,
        messages: [
          {   role: 'system',   content: [     'You are ExpiryGuard Smart Recipe Search.',     'Answer the user’s actual cooking question, even when some requested ingredients are missing from inventory.',     'Use inventory items as context, not as a strict limitation.',     'For every recommendation, distinguish between available ingredients, missing ingredients, and expired ingredients.',     'Never recommend, imply, or provide instructions to use expired food.',     'Explicitly tell the user to avoid expired ingredients.',     'Do not claim an ingredient is available unless it appears in the supplied inventory.',     'If an ingredient is missing, include it in a short "Missing ingredients" list.',     'Prioritize ingredients already available and ingredients expiring soon when relevant.',     'Respect cuisine, dietary, and cooking-time preferences.',     'Only restrict recipes to inventory ingredients when the user explicitly asks for a pantry-only recipe.',     'Keep the response practical and concise.',     'The response is cooking guidance, not a food-safety certification.',   ].join(' '), },
          { role: 'user', content: prompt },
        ],
      }),
    })
  } catch { clearTimeout(timeout); return json({ error: 'The recipe service could not be reached. Local recipe search is still available.' }, 503, origin, env) }
  clearTimeout(timeout)

  if (upstream.status === 401 || upstream.status === 403 || upstream.status === 402) return json({ error: 'The recipe service is unavailable right now. Local recipe search is still available.' }, 503, origin, env)
  if (upstream.status === 429) return json({ error: 'The free model is temporarily at its limit. Try again later or use local recipe search.' }, 429, origin, env)
  if (!upstream.ok) return json({ error: 'The recipe service returned an error. Local recipe search is still available.' }, 502, origin, env)

  let data: OpenRouterResponse
  try { data = await upstream.json() as OpenRouterResponse } catch { return json({ error: 'The recipe service returned an invalid response.' }, 502, origin, env) }
  const answer = data.choices?.[0]?.message?.content?.trim()
  if (!answer) return json({ error: 'The recipe service returned no answer.' }, 502, origin, env)
  return json({ answer: answer.slice(0, 6000) }, 200, origin, env)
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, configured: isConfigured(env) }, 200, origin, env)
    if (url.pathname !== ROUTE) return json({ error: 'Not found.' }, 404, origin, env)
    if (request.method === 'OPTIONS') {
      if (origin && !allowedOrigins(env).includes(origin)) return json({ error: 'Origin not allowed.' }, 403, origin, env)
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) })
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, origin, env)
    return handleRecipeRequest(request, env, origin)
  },
}

export default worker
