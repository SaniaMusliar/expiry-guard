import type { FoodItem } from '../types'
import type { RecipeFilters } from './recipes'

const ENDPOINT = (import.meta.env.VITE_RECIPE_PROXY_URL?.trim() || '/api/ask-recipe')

type AskArgs = {
  question: string
  items: FoodItem[]
  offset: number
  filters: RecipeFilters
  localRecipeTitles: string[]
}

type ProxyResponse = { answer?: string; error?: string }

export async function askOpenRouter({ question, items, offset, filters, localRecipeTitles }: AskArgs) {
  if (!question.trim()) throw new Error('Type a cooking question first.')
  if (!navigator.onLine) throw new Error('Ask AI needs an internet connection. Local recipe search is still available offline.')

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question.trim(), items, offset, filters, localRecipeTitles: localRecipeTitles.slice(0, 50) }),
    })
  } catch { throw new Error('Ask AI is unavailable right now. Check your connection, or continue with local recipe search.') }

  let data: ProxyResponse = {}
  try { data = await response.json() as ProxyResponse } catch { /* handled below */ }
  if (!response.ok) {
    if (response.status === 404 || response.status === 503) throw new Error(data.error || 'Ask AI is not configured yet. Local recipe search is still available.')
    if (response.status === 429) throw new Error(data.error || 'Ask AI is temporarily busy. Try again later or use local recipe search.')
    throw new Error(data.error || 'Ask AI could not complete that request. Local recipe search is still available.')
  }
  if (!data.answer?.trim()) throw new Error('Ask AI returned no answer. Please try again or use local recipe search.')
  return data.answer.trim()
}
