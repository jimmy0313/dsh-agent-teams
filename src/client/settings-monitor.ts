/** Shared demand-driven state for the AgentTeams settings panel. */

/** Member route knobs persisted through the settings panel. */
export interface MemberModelSettings {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** One role's full definition: identity, persona, and model route. */
export interface RoleSettings extends MemberModelSettings {
  readonly name?: string
  readonly description?: string
}

/** Runtime settings shape, mirrored from the host store. */
export interface RuntimeSettings {
  readonly memberModel?: MemberModelSettings
  readonly roleModels?: Record<string, RoleSettings>
  readonly memberMaxTokens?: number
  readonly memberMaxDepth?: number
  readonly maxMembers?: number
}

/** One provider route in the settings catalog. */
export interface SettingsProvider {
  readonly id: string
  readonly name: string
}

/** One model in the settings catalog. */
export interface SettingsModel {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One reasoning effort in the settings catalog. */
export interface SettingsEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One role row in the settings catalog. */
export interface SettingsRole {
  readonly key: string
  readonly name: string
  readonly builtin: boolean
}

/** Model catalog assembled by the host for the panel. */
export interface SettingsCatalog {
  readonly providers: readonly SettingsProvider[]
  readonly models: Record<string, readonly SettingsModel[]>
  readonly efforts: Record<string, readonly SettingsEffort[]>
  readonly defaultEfforts: Record<string, string>
  readonly effortErrors: Record<string, string>
  readonly roles: readonly SettingsRole[]
}

/** GET payload served by the host settings route. */
export interface SettingsResponse {
  readonly settings: RuntimeSettings
  readonly catalog: SettingsCatalog
}

/** Live panel state (React external-store shape). */
export interface SettingsState {
  readonly settings: RuntimeSettings
  readonly catalog: SettingsCatalog | undefined
  readonly loaded: boolean
  readonly loading: boolean
  readonly saving: boolean
  readonly error: string
  readonly saveError: string
}

const EMPTY_SETTINGS: RuntimeSettings = {}
const EMPTY_STATE: SettingsState = Object.freeze({
  settings: EMPTY_SETTINGS,
  catalog: undefined,
  loaded: false,
  loading: false,
  saving: false,
  error: '',
  saveError: '',
})

let state: SettingsState = EMPTY_STATE
const listeners = new Set<() => void>()

function publish(next: SettingsState): void {
  if (next === state) return
  state = next
  for (const listener of listeners) listener()
}

/** Subscribe to settings-panel state. */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Read the stable settings-panel state snapshot. */
export function getSettingsSnapshot(): SettingsState {
  return state
}

/** Host route serving the settings catalog and persisted settings. */
export const SETTINGS_URL = '/plugins/dsh-agent-teams/settings'

interface SettingsFetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

/** Injectable browser primitives for the settings controller and its tests. */
export interface SettingsRuntime {
  readonly fetch?: (
    url: string,
    init: RequestInit,
  ) => Promise<SettingsFetchResponse>
  readonly publish?: (update: Partial<SettingsState>) => void
}

function defaultFetch(url: string, init: RequestInit): Promise<SettingsFetchResponse> {
  return fetch(url, init)
}

/** Merge a partial update into the current settings state. */
export function publishSettingsUpdate(update: Partial<SettingsState>): void {
  publish({ ...state, ...update })
}

/** Fetch the current settings + catalog and publish them. */
export async function loadSettings(runtime: SettingsRuntime = {}): Promise<void> {
  const fetchSettings = runtime.fetch ?? defaultFetch
  const publishUpdate = runtime.publish ?? publishSettingsUpdate
  publishUpdate({ loading: true, error: '' })
  try {
    const response = await fetchSettings(SETTINGS_URL, { cache: 'no-store' })
    if (!response.ok) {
      publishUpdate({ loading: false, error: `settings load failed (${response.status})` })
      return
    }
    const body = (await response.json()) as { settings?: unknown; catalog?: unknown }
    const settings = isRuntimeSettings(body.settings) ? body.settings : EMPTY_SETTINGS
    const catalog = isSettingsCatalog(body.catalog) ? body.catalog : undefined
    publishUpdate({ settings, catalog, loaded: true, loading: false, error: '' })
  } catch (error: unknown) {
    publishUpdate({ loading: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Persist settings; on success the returned settings become the live snapshot. */
export async function saveSettings(
  settings: RuntimeSettings,
  runtime: SettingsRuntime = {},
): Promise<boolean> {
  const fetchSettings = runtime.fetch ?? defaultFetch
  const publishUpdate = runtime.publish ?? publishSettingsUpdate
  publishUpdate({ saving: true, saveError: '' })
  try {
    const response = await fetchSettings(SETTINGS_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(settings),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
      publishUpdate({ saving: false, saveError: body?.error ?? `settings save failed (${response.status})` })
      return false
    }
    const saved = (await response.json()) as { settings?: unknown }
    const next = isRuntimeSettings(saved.settings) ? saved.settings : settings
    publishUpdate({ settings: next, saving: false, saveError: '', error: '' })
    return true
  } catch (error: unknown) {
    publishUpdate({ saving: false, saveError: error instanceof Error ? error.message : String(error) })
    return false
  }
}

/**
 * Decide whether a freshly loaded settings snapshot should replace the form
 * draft. The panel initializes its draft from the pre-load snapshot (empty on
 * a fresh page), so once the async load lands it must adopt the persisted
 * settings — otherwise the form opens blank and the next save overwrites the
 * settings file with an empty payload. It must never clobber edits the user
 * already made before the load completed.
 */
export function shouldAdoptLoadedSettings(
  loaded: boolean,
  hydrated: boolean,
  draft: RuntimeSettings,
): boolean {
  return loaded && !hydrated && Object.keys(draft).length === 0
}

/** Reset the in-memory store (test isolation). */
export function resetSettingsState(): void {
  publish(EMPTY_STATE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMemberModelSettings(value: unknown): value is MemberModelSettings {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  const optionalString = (key: string): boolean =>
    value[key] === undefined || typeof value[key] === 'string'
  return optionalString('provider') && optionalString('model') && optionalString('reasoningEffort')
    && optionalString('name') && optionalString('description')
}

function isRuntimeSettings(value: unknown): value is RuntimeSettings {
  if (value === undefined) return false
  if (!isRecord(value)) return false
  if (!isMemberModelSettings(value['memberModel'])) return false
  if (value['roleModels'] !== undefined) {
    if (!isRecord(value['roleModels'])) return false
    if (!Object.values(value['roleModels']).every(isMemberModelSettings)) return false
  }
  const optionalInt = (key: string): boolean =>
    value[key] === undefined || (typeof value[key] === 'number' && Number.isSafeInteger(value[key] as number))
  return optionalInt('memberMaxTokens') && optionalInt('memberMaxDepth') && optionalInt('maxMembers')
}

function isSettingsCatalog(value: unknown): value is SettingsCatalog {
  if (!isRecord(value)) return false
  if (!Array.isArray(value['providers'])) return false
  return isRecord(value['models'])
    && isRecord(value['efforts'])
    && isRecord(value['defaultEfforts'])
    && isRecord(value['effortErrors'])
    && Array.isArray(value['roles'])
}
