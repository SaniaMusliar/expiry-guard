import type { FoodItem } from '../types'
import type { RecipeFilters } from './recipes'

const PROXY_URL = import.meta.env.VITE_RECIPE_PROXY_URL?.trim()

const ENDPOINT = PROXY_URL
  ? `${PROXY_URL.replace(/\/+$/, '').replace(/\/api\/ask-recipe$/, '')}/api/ask-recipe`
  : '/api/ask-recipe'

type AskArgs = {
  question: string
  items: FoodItem[]
  offset: number
  filters: RecipeFilters
  localRecipeTitles: string[]
}

type ProxyResponse = {
  answer?: string
  error?: string
}

export async function askOpenRouter({
  question,
  items,
  offset,
  filters,
  localRecipeTitles,
}: AskArgs) {
  if (!question.trim()) {
    throw new Error('Type a cooking question first.')
  }

  if (!navigator.onLine) {
    throw new Error(
      'Ask AI needs an internet connection. Local recipe search is still available offline.',
    )
  }

  let response: Response

  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question: question.trim(),

        // Send only the fields required for recipe recommendations.
        // Large fields such as imageUrl, notes, barcode, id and createdAt
        // are intentionally excluded.
        items: items.slice(0, 50).map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          location: item.location,
          expiryDate: item.expiryDate,
          daysUntilExpiry: Math.ceil(
            (new Date(item.expiryDate).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24),
          ),
        })),

        offset,
        filters,
        localRecipeTitles: localRecipeTitles.slice(0, 50),
      }),
    })
  } catch {
    throw new Error(
      'Ask AI is unavailable right now. Check your connection, or continue with local recipe search.',
    )
  }

  let data: ProxyResponse = {}

  try {
    data = (await response.json()) as ProxyResponse
  } catch {
    // The response was not valid JSON.
  }

  if (!response.ok) {
    if (response.status === 404 || response.status === 503) {
      throw new Error(
        data.error ||
          'Ask AI is not configured yet. Local recipe search is still available.',
      )
    }

    if (response.status === 413) {
      throw new Error(
        'The recipe request is too large. Remove some items or try again.',
      )
    }

    if (response.status === 429) {
      throw new Error(
        data.error ||
          'Ask AI is temporarily busy. Try again later or use local recipe search.',
      )
    }

    throw new Error(
      data.error ||
        'Ask AI could not complete that request. Local recipe search is still available.',
    )
  }

  if (!data.answer?.trim()) {
    throw new Error(
      'Ask AI returned no answer. Please try again or use local recipe search.',
    )
  }

  return data.answer.trim()
}
