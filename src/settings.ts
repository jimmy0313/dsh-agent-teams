/**
 * Runtime AgentTeams settings and the model catalog behind the Web settings
 * panel.
 *
 * Plugin configuration (`cordis.patch.yml`) is static: it can set a default
 * member model and team caps, but only by editing the profile. The settings
 * panel needs a runtime-mutable, crash-safe store the host reads at member
 * spawn time and the browser writes through the settings routes. That store
 * lives in one JSON file (default `~/.dsh/dsh-agent-teams/settings.json`),
 * written atomically through the same Windows-hardened replace path as team
 * state.
 *
 * @module dsh-agent-teams/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { replaceFileAtomicOrDirect } from './state.ts'
import { ROLE_DEFINITIONS } from './roles.ts'

/** Default member route knobs set through the settings panel. */
export interface MemberModelSettings {
  /** Explicit provider route; requires `model`. Absent = inherit captain route. */
  provider?: string
  /** Default model id for every member. */
  model?: string
  /** Default reasoning effort id, or `"default"` to force the model's own default. */
  reasoningEffort?: string
}

/** One role's full definition: identity, persona, and model route. */
export interface RoleSettings extends MemberModelSettings {
  /** Optional display name for a custom role (defaults to its key). */
  name?: string
  /** Role persona/definition appended to the member's system prompt. */
  description?: string
}

/** Runtime-mutable settings, overriding the static plugin config. */
export interface RuntimeSettings {
  /** Member default provider/model/effort. */
  memberModel?: MemberModelSettings
  /** Per-role definitions keyed by role key (built-in or custom). */
  roleModels?: Record<string, RoleSettings>
  /** Maximum output tokens for each member request. */
  memberMaxTokens?: number
  /** Member delegation depth cap. */
  memberMaxDepth?: number
  /** Team size cap in members. */
  maxMembers?: number
}

/** One provider route as shown in the settings panel. */
export interface SettingsProvider {
  readonly id: string
  readonly name: string
}

/** One model as shown in the settings panel. */
export interface SettingsModel {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One reasoning effort as shown in the settings panel. */
export interface SettingsEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One role row in the settings panel (built-in or user-added). */
export interface SettingsRole {
  readonly key: string
  readonly name: string
  /** False for the built-in catalog; only custom roles can be removed. */
  readonly builtin: boolean
}

/** Catalog assembled from the live LLM registry for the settings panel. */
export interface SettingsCatalog {
  readonly providers: readonly SettingsProvider[]
  /** Models keyed by provider id, in adapter-preferred order. */
  readonly models: Record<string, readonly SettingsModel[]>
  /** Reasoning efforts keyed by `${provider}/${model}`. */
  readonly efforts: Record<string, readonly SettingsEffort[]>
  /** Default effort id keyed by `${provider}/${model}`. */
  readonly defaultEfforts: Record<string, string>
  /** Per-route resolution failure messages, keyed the same way. */
  readonly effortErrors: Record<string, string>
  /** Role rows: built-in definitions plus custom keys from the settings. */
  readonly roles: readonly SettingsRole[]
}

/** Full GET payload for the settings panel. */
export interface SettingsResponse {
  readonly settings: RuntimeSettings
  readonly catalog: SettingsCatalog
}

/** Where the settings file lives by default. */
export function defaultSettingsFile(): string {
  return join(homedir(), '.dsh', 'dsh-agent-teams', 'settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function safeIntegerIn(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : undefined
}

/**
 * Validate one `MemberModelSettings` object. A completely empty object is
 * valid (it means "inherit"); a provider requires a paired model; every
 * present string must be non-empty.
 */
function parseMemberModelSettings(value: unknown): MemberModelSettings | undefined {
  if (!isRecord(value)) return undefined
  const memberModel: MemberModelSettings = {}
  if (value['provider'] !== undefined) {
    const provider = nonEmptyString(value['provider'])
    if (provider === undefined) return undefined
    memberModel.provider = provider
  }
  if (value['model'] !== undefined) {
    const model = nonEmptyString(value['model'])
    if (model === undefined) return undefined
    memberModel.model = model
  }
  if (value['reasoningEffort'] !== undefined) {
    const effort = nonEmptyString(value['reasoningEffort'])
    if (effort === undefined) return undefined
    memberModel.reasoningEffort = effort
  }
  // An explicit provider needs a model to name a complete route.
  if (memberModel.provider !== undefined && memberModel.model === undefined) return undefined
  return memberModel
}

/** Validate one role definition: model-route rules plus optional name/description. */
function parseRoleSettings(value: unknown): RoleSettings | undefined {
  const route = parseMemberModelSettings(value)
  if (route === undefined) return undefined
  const role: RoleSettings = { ...route }
  if (!isRecord(value)) return role
  if (value['name'] !== undefined) {
    const name = nonEmptyString(value['name'])
    if (name === undefined) return undefined
    role.name = name
  }
  if (value['description'] !== undefined) {
    const description = nonEmptyString(value['description'])
    if (description === undefined) return undefined
    role.description = description
  }
  return role
}

/**
 * Validate one parsed settings value into a clean, key-stripped record.
 * Returns `undefined` on any structural violation; the caller decides whether
 * that means "report a 400" (PUT) or "fall back to defaults" (file read).
 */
export function parseSettings(value: unknown): RuntimeSettings | undefined {
  if (!isRecord(value)) return undefined
  const settings: RuntimeSettings = {}

  if (value['memberModel'] !== undefined) {
    const memberModel = parseMemberModelSettings(value['memberModel'])
    if (memberModel === undefined) return undefined
    if (Object.keys(memberModel).length > 0) settings.memberModel = memberModel
  }

  if (value['roleModels'] !== undefined) {
    if (!isRecord(value['roleModels'])) return undefined
    const roleModels: Record<string, RoleSettings> = {}
    for (const [key, entry] of Object.entries(value['roleModels'])) {
      if (key.trim() === '') return undefined
      const parsed = parseRoleSettings(entry)
      if (parsed === undefined) return undefined
      // Keep the entry even when empty: an empty row simply inherits the
      // global default / captain route, and dropping it would lose the row.
      roleModels[key] = parsed
    }
    if (Object.keys(roleModels).length > 0) settings.roleModels = roleModels
  }

  if (value['memberMaxTokens'] !== undefined) {
    const maxTokens = safeIntegerIn(value['memberMaxTokens'], 1)
    if (maxTokens === undefined) return undefined
    settings.memberMaxTokens = maxTokens
  }
  if (value['memberMaxDepth'] !== undefined) {
    const maxDepth = safeIntegerIn(value['memberMaxDepth'], 0)
    if (maxDepth === undefined) return undefined
    settings.memberMaxDepth = maxDepth
  }
  if (value['maxMembers'] !== undefined) {
    const maxMembers = safeIntegerIn(value['maxMembers'], 1)
    if (maxMembers === undefined) return undefined
    settings.maxMembers = maxMembers
  }
  return settings
}

/** Read the settings file synchronously (startup path), defaulting on absence/corruption. */
export function readSettingsFileSync(file: string): RuntimeSettings {
  try {
    const raw = readFileSync(file, 'utf8')
    const value: unknown = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
    return parseSettings(value) ?? {}
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    // A corrupt settings file must never block boot; the panel can overwrite it.
    return {}
  }
}

/** Read the settings file asynchronously (settings GET path). */
export async function readSettingsFile(file: string): Promise<RuntimeSettings> {
  try {
    const raw = await readFile(file, 'utf8')
    const value: unknown = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
    return parseSettings(value) ?? {}
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

/** Atomically persist the settings file (same crash-safe replace path as team state). */
export async function writeSettingsFile(file: string, settings: RuntimeSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const content = `${JSON.stringify(settings, null, 2)}\n`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await replaceFileAtomicOrDirect(temporary, file, content, {
    rename: (from, to) => rename(from, to),
    writeFile: (target, payload) => writeFile(target, payload, 'utf8'),
    remove: (path) => rm(path, { force: true }),
  })
}

function providerCatalog(ctx: Context): SettingsProvider[] {
  try {
    return ctx.llm.listProviders().map(({ id, name }) => ({ id, name }))
  } catch {
    return []
  }
}

/**
 * Assemble the settings-panel catalog from the live LLM registry. Provider and
 * model listings are advisory (a provider or model can appear/disappear with
 * HMR), so every step is individually contained: one broken route must not
 * blank the whole panel.
 */
export async function buildSettingsCatalog(
  ctx: Context,
  settings?: RuntimeSettings,
): Promise<SettingsCatalog> {
  const providers = providerCatalog(ctx)
  const models: Record<string, SettingsModel[]> = {}
  for (const provider of providers) {
    try {
      const listed = await ctx.llm.listModels(provider.id)
      models[provider.id] = listed.map((model) => ({
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
      }))
    } catch {
      models[provider.id] = []
    }
  }

  const efforts: Record<string, SettingsEffort[]> = {}
  const defaultEfforts: Record<string, string> = {}
  const effortErrors: Record<string, string> = {}
  // Effort metadata is resolved per exact route; materialize it for every
  // advertised provider/model pair so the panel can show the dropdown without
  // a second round-trip. Resolution is cheap and advisory; failures are kept
  // per-route so a single unknown model id cannot break the payload.
  for (const provider of providers) {
    for (const model of models[provider.id] ?? []) {
      const key = `${provider.id}/${model.id}`
      try {
        const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const reasoning = info.reasoning
        if (reasoning === undefined || reasoning.efforts.length === 0) continue
        efforts[key] = reasoning.efforts.map((effort) => ({
          id: effort.id,
          name: effort.name,
          ...effort.description === undefined ? {} : { description: effort.description },
        }))
        if (reasoning.defaultEffort !== undefined) defaultEfforts[key] = reasoning.defaultEffort
      } catch (error: unknown) {
        effortErrors[key] = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return { providers, models, efforts, defaultEfforts, effortErrors, roles: roleCatalog(settings) }
}

/**
 * The role rows shown in the settings panel: the built-in catalog plus every
 * custom key the user added. A custom key equal to a built-in key is absorbed
 * by the built-in row.
 */
export function roleCatalog(settings?: RuntimeSettings): readonly SettingsRole[] {
  const builtins = ROLE_DEFINITIONS.map(({ key, name }) => ({ key, name, builtin: true }))
  const roleModels = settings?.roleModels ?? {}
  const customKeys = Object.keys(roleModels)
    .filter((key) => !ROLE_DEFINITIONS.some((role) => role.key === key))
  if (customKeys.length === 0) return builtins
  return [
    ...builtins,
    ...customKeys.map((key) => ({
      key,
      name: roleModels[key]?.name ?? key,
      builtin: false,
    })),
  ]
}

function normalizeRole(value: string): string {
  return value.toLowerCase().trim()
}

/** ASCII word-boundary escape for token matching. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Index of `key` as a standalone token inside `target`, or undefined. */
function tokenIndexOf(target: string, key: string): number | undefined {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(key)}([^a-z0-9]|$)`)
  const match = pattern.exec(target)
  if (match === null) return undefined
  return match.index + (match[1] ?? '').length
}

/**
 * Match a member's free-form `role` string against the configured per-role
 * routes, mirroring the artwork matcher's compound-title-first intent:
 *
 * 1. exact key equality wins;
 * 2. otherwise keys that appear as standalone tokens in the role string —
 *    the earliest token wins (so "QA Engineer" hits `qa`, and a `frontend`
 *    custom key beats the generic `engineer` in "Frontend Engineer"), ties
 *    broken by the longest key;
 * 3. otherwise substring containment in either direction, longest key wins.
 *
 * @returns the matched role's settings (route + persona), or `undefined` when
 *   no role matches (callers then fall back to the global member default).
 */
export function matchRoleSettings(
  settings: RuntimeSettings | undefined,
  role: string | undefined,
): RoleSettings | undefined {
  const roleModels = settings?.roleModels
  if (roleModels === undefined || role === undefined) return undefined
  const target = normalizeRole(role)
  if (target === '') return undefined
  const entries = Object.entries(roleModels)
  if (entries.length === 0) return undefined

  for (const [key, entry] of entries) {
    if (normalizeRole(key) === target) return entry
  }

  let bestToken: { index: number; length: number; entry: RoleSettings } | undefined
  let bestSubstring: { length: number; entry: RoleSettings } | undefined
  for (const [key, entry] of entries) {
    const normalized = normalizeRole(key)
    if (normalized === '') continue
    const tokenIndex = tokenIndexOf(target, normalized)
    if (tokenIndex !== undefined) {
      if (bestToken === undefined
        || tokenIndex < bestToken.index
        || (tokenIndex === bestToken.index && normalized.length > bestToken.length)) {
        bestToken = { index: tokenIndex, length: normalized.length, entry }
      }
      continue
    }
    if (target.includes(normalized) || normalized.includes(target)) {
      if (bestSubstring === undefined || normalized.length > bestSubstring.length) {
        bestSubstring = { length: normalized.length, entry }
      }
    }
  }
  return bestToken?.entry ?? bestSubstring?.entry
}
