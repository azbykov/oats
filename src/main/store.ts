import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILT_IN_RECIPES, BUILT_IN_TEMPLATES, DEFAULT_SETTINGS } from '../shared/defaults'
import type { AppData } from '../shared/types'

// A JSON file is enough for a single-user app and avoids native module rebuilds.
const dir = () => app.getPath('userData')
const file = () => join(dir(), 'oats-data.json')

function initial(): AppData {
  return {
    notes: [],
    folders: [],
    templates: BUILT_IN_TEMPLATES,
    recipes: BUILT_IN_RECIPES,
    settings: { ...DEFAULT_SETTINGS }
  }
}

export function loadData(): AppData {
  if (!existsSync(file())) return initial()
  try {
    const data = JSON.parse(readFileSync(file(), 'utf8')) as Partial<AppData>
    const base = initial()
    const userTemplates = (data.templates ?? []).filter((t) => !t.builtIn)
    const userRecipes = (data.recipes ?? []).filter((r) => !r.builtIn)
    return {
      notes: data.notes ?? [],
      folders: data.folders ?? [],
      templates: [...base.templates, ...userTemplates],
      recipes: [...base.recipes, ...userRecipes],
      settings: { ...base.settings, ...data.settings }
    }
  } catch (err) {
    console.error('Failed to read data file, starting fresh', err)
    return initial()
  }
}

let pending: AppData | null = null
let timer: NodeJS.Timeout | null = null

function flush() {
  if (!pending) return
  mkdirSync(dir(), { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(pending))
  renameSync(tmp, file())
  pending = null
}

export function saveData(data: AppData) {
  pending = data
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 300)
}

export function flushData() {
  if (timer) clearTimeout(timer)
  flush()
}
