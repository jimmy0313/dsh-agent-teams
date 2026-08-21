/**
 * AgentTeams sub-agent settings page, contributed to the sidebar Settings
 * panel (`settings.section`).
 *
 * One interface defines the sub-agent role catalog and per-role model routing:
 * every role (built-in or custom) carries a display name, a persona
 * description that becomes part of the member's system prompt, and its own
 * provider/model/reasoning-effort route. A global member default covers roles
 * without a match, and numeric caps bound output length, team size, and
 * delegation depth. Settings are global (not per team or per session): the
 * host persists them to one JSON file and applies them to every member the
 * captain spawns afterwards (role-matched routes win over the global default).
 * @module dsh-agent-teams/client/settings
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings.section slot declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  getSettingsSnapshot,
  loadSettings,
  saveSettings,
  shouldAdoptLoadedSettings,
  subscribeSettings,
  type MemberModelSettings,
  type RoleSettings,
  type RuntimeSettings,
  type SettingsCatalog,
} from './settings-monitor.ts'
import css from './SettingsPanel.module.css'

/** Empty-string form sentinel means "inherit" (no explicit value). */
const INHERIT = ''

/** Reasoning-effort sentinel forcing the target model's own default. */
const EFFORT_DEFAULT = 'default'

function fieldClass(hasError: boolean): string | undefined {
  return hasError ? `${css.field ?? ''} ${css.fieldError ?? ''}`.trim() : css.field
}

/** Parse a numeric input's string value into a positive integer or undefined. */
function optionalInt(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Strip empty/undefined fields so cleared controls disappear from the JSON.
 * Values are kept raw (no trim): trimming on every keystroke would swallow the
 * space the user just typed. Trimming happens once on save (`cleanForSave`). */
function cleanedRoute(next: MemberModelSettings): MemberModelSettings {
  return Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== '' && value !== undefined),
  )
}

/** Trim every string and drop empties for one route row (save-time only). */
function cleanedRouteForSave(next: MemberModelSettings): MemberModelSettings {
  return Object.fromEntries(
    Object.entries(next)
      .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => value !== '' && value !== undefined),
  )
}

/** Trim all free-text settings before they leave the panel, so trailing
 * spaces typed while editing never persist (the host parser rejects them). */
function cleanForSave(next: RuntimeSettings): RuntimeSettings {
  const roleModels: Record<string, RoleSettings> = {}
  if (next.roleModels !== undefined) {
    for (const [key, entry] of Object.entries(next.roleModels)) {
      roleModels[key] = cleanedRouteForSave(entry)
    }
  }
  return {
    ...(next.memberModel !== undefined
      && Object.keys(cleanedRouteForSave(next.memberModel)).length > 0
      ? { memberModel: cleanedRouteForSave(next.memberModel) }
      : {}),
    ...(Object.keys(roleModels).length > 0 ? { roleModels } : {}),
    ...next.memberMaxTokens !== undefined ? { memberMaxTokens: next.memberMaxTokens } : {},
    ...next.memberMaxDepth !== undefined ? { memberMaxDepth: next.memberMaxDepth } : {},
    ...next.maxMembers !== undefined ? { maxMembers: next.maxMembers } : {},
  }
}

/** A provider/model/effort field group, shared by the global default and every
 * role row so all model selections behave identically. */
function RouteFields({ value, onChange, catalog, idPrefix }: {
  readonly value: MemberModelSettings
  readonly onChange: (next: MemberModelSettings) => void
  readonly catalog: SettingsCatalog | undefined
  readonly idPrefix: string
}) {
  const provider = value.provider ?? ''
  const model = value.model ?? ''
  const models = catalog?.models[provider] ?? []
  const routeKey = provider !== '' && model !== '' ? `${provider}/${model}` : ''
  const efforts = catalog?.efforts[routeKey] ?? []

  const setField = (patch: Partial<MemberModelSettings>): void => {
    onChange({ ...value, ...patch })
  }

  return (
    <>
      <label className={css.label} htmlFor={`${idPrefix}-provider`}>Provider</label>
      <select
        id={`${idPrefix}-provider`}
        className={css.select}
        value={provider}
        onChange={(event) => {
          const nextProvider = event.target.value
          // A provider change clears the model: ids are provider-specific, and
          // the host requires a provider to be paired with a model.
          setField(nextProvider === INHERIT
            ? { provider: undefined, model: undefined }
            : { provider: nextProvider, model: undefined })
        }}
      >
        <option value={INHERIT}>继承组织者（默认）</option>
        {(catalog?.providers ?? []).map((entry) => (
          <option key={entry.id} value={entry.id}>{entry.name} ({entry.id})</option>
        ))}
      </select>

      <label className={css.label} htmlFor={`${idPrefix}-model`}>成员模型</label>
      {provider === INHERIT ? (
        <input
          id={`${idPrefix}-model`}
          className={css.input}
          type="text"
          placeholder="继承组织者当前模型（可填模型 id）"
          value={model}
          onChange={(event) => { setField({ model: event.target.value }) }}
        />
      ) : (
        <select
          id={`${idPrefix}-model`}
          className={css.select}
          value={model}
          onChange={(event) => { setField({ model: event.target.value }) }}
        >
          <option value={INHERIT}>继承组织者当前模型</option>
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name} ({entry.id})</option>
          ))}
        </select>
      )}

      <label className={css.label} htmlFor={`${idPrefix}-effort`}>思考强度</label>
      <select
        id={`${idPrefix}-effort`}
        className={css.select}
        value={value.reasoningEffort ?? INHERIT}
        onChange={(event) => {
          setField({ reasoningEffort: event.target.value === INHERIT ? undefined : event.target.value })
        }}
      >
        <option value={INHERIT}>继承（默认）</option>
        <option value={EFFORT_DEFAULT}>目标模型默认档</option>
        {efforts.map((effort) => (
          <option key={effort.id} value={effort.id}>{effort.name} ({effort.id})</option>
        ))}
      </select>
    </>
  )
}

/** The AgentTeams「子代理设置」page inside the sidebar Settings panel. */
export function SettingsPanel(_props: PropsRuntime<'settings.section'>) {
  const state = useSyncExternalStore(subscribeSettings, getSettingsSnapshot)
  const [draft, setDraft] = useState<RuntimeSettings>(state.settings)
  const [localError, setLocalError] = useState('')
  const [newRole, setNewRole] = useState('')
  // The draft initializes from the pre-load snapshot, which is empty on a
  // fresh page. Once the async load lands, adopt the persisted settings into
  // the form exactly once — without this the panel always opens blank and a
  // save silently overwrites the settings file with the empty draft.
  const hydrated = useRef(false)

  // The section mounts when the Settings panel opens it; load once so the
  // catalog (providers/models/efforts) and persisted settings are fresh.
  useEffect(() => {
    if (!state.loaded && !state.loading) void loadSettings()
  }, [state.loaded, state.loading])

  // Hydrate the form from the loaded settings. Marking hydration complete as
  // soon as the load lands — even when the draft is kept because the user
  // already started editing — closes the window where a later 清空表单 could
  // otherwise resurrect the persisted values.
  useEffect(() => {
    if (!state.loaded || hydrated.current) return
    hydrated.current = true
    if (shouldAdoptLoadedSettings(state.loaded, false, draft)) {
      setDraft(state.settings)
    }
  }, [state.loaded, state.settings, draft])

  const setMemberModel = (next: MemberModelSettings): void => {
    setDraft((previous) => {
      const cleaned = cleanedRoute(next)
      return Object.keys(cleaned).length === 0
        ? { ...previous, memberModel: undefined }
        : { ...previous, memberModel: cleaned }
    })
  }

  const setRole = (key: string, patch: Partial<RoleSettings>): void => {
    setDraft((previous) => {
      const current = previous.roleModels?.[key] ?? {}
      const next = { ...current, ...patch }
      const cleaned = cleanedRoute(next)
      return {
        ...previous,
        roleModels: { ...(previous.roleModels ?? {}), [key]: cleaned },
      }
    })
  }

  const removeRole = (key: string): void => {
    setDraft((previous) => {
      const roleModels = { ...(previous.roleModels ?? {}) }
      delete roleModels[key]
      return { ...previous, roleModels: Object.keys(roleModels).length === 0 ? undefined : roleModels }
    })
  }

  const addRole = (): void => {
    const key = newRole.trim()
    if (key === '') return
    const exists = (state.catalog?.roles ?? []).some((role) => role.key === key)
    if (exists) {
      setLocalError(`角色 "${key}" 已存在`)
      return
    }
    setLocalError('')
    setRole(key, {})
    setNewRole('')
  }

  const save = (): void => {
    // Free-text input keeps raw spaces while editing; trim once here so the
    // payload never carries trailing whitespace (the host parser rejects it).
    const cleaned = cleanForSave(draft)
    // A provider route needs a model to name a complete route (mirrors the
    // host validation); catch it before the request so the panel explains why.
    const invalid = (entry: MemberModelSettings | undefined): boolean =>
      entry?.provider !== undefined && entry.model === undefined
    if (invalid(cleaned.memberModel)
      || Object.values(cleaned.roleModels ?? {}).some(invalid)) {
      setLocalError('选择 Provider 后需要同时选择成员模型')
      return
    }
    setLocalError('')
    void saveSettings(cleaned)
  }
  const reset = (): void => {
    setLocalError('')
    setDraft({})
  }
  const resetAndSave = (): void => {
    setLocalError('')
    setDraft({})
    void saveSettings({})
  }

  const roles = state.catalog?.roles ?? []
  const roleModels = draft.roleModels ?? {}

  return (
    <div className={css.page} data-agent-teams-settings>
      <p className={css.hint}>
        定义各子代理（角色）的职责与模型：新建成员时按其 role 匹配角色，使用该角色的模型路由与职责描述；
        未匹配的角色回退到全局默认，再回退到组织者当前路由。
      </p>

      <section className={css.section}>
        <header className={css.sectionHead}>
          <span className={css.sectionTitle}>全局默认（回退）</span>
        </header>
        <RouteFields
          value={draft.memberModel ?? {}}
          onChange={setMemberModel}
          catalog={state.catalog}
          idPrefix="at-settings-global"
        />
      </section>

      <section className={css.section}>
        <header className={css.sectionHead}>
          <span className={css.sectionTitle}>子代理角色</span>
          <span className={css.sectionHint}>共 {roles.length} 个</span>
        </header>
        {roles.map((role) => (
          <div key={role.key} className={css.roleBlock} data-role-key={role.key}>
            <header className={css.roleHead}>
              {role.builtin ? (
                <span className={css.roleName}>{role.name}</span>
              ) : (
                <input
                  className={css.roleNameInput}
                  type="text"
                  placeholder="显示名称"
                  value={roleModels[role.key]?.name ?? role.name}
                  onChange={(event) => { setRole(role.key, { name: event.target.value }) }}
                />
              )}
              <span className={css.roleKey}>{role.key}</span>
              {!role.builtin && (
                <button
                  type="button"
                  className={css.removeButton}
                  onClick={() => { removeRole(role.key) }}
                  aria-label={`删除角色 ${role.name}`}
                  title="删除此角色"
                >
                  删除
                </button>
              )}
            </header>
            <label className={css.label} htmlFor={`at-settings-role-${role.key}-desc`}>职责描述（写入成员 persona）</label>
            <textarea
              id={`at-settings-role-${role.key}-desc`}
              className={css.textarea}
              rows={2}
              placeholder={role.builtin ? '使用内置默认描述' : '描述该角色的职责，将写入其系统提示'}
              value={roleModels[role.key]?.description ?? ''}
              onChange={(event) => { setRole(role.key, { description: event.target.value }) }}
            />
            <RouteFields
              value={roleModels[role.key] ?? {}}
              onChange={(next) => { setRole(role.key, next) }}
              catalog={state.catalog}
              idPrefix={`at-settings-role-${role.key}`}
            />
          </div>
        ))}
        <div className={css.addRoleRow}>
          <input
            className={css.input}
            type="text"
            placeholder="自定义角色 key，如 frontend / 前端"
            value={newRole}
            onChange={(event) => { setNewRole(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addRole()
              }
            }}
          />
          <button type="button" className={css.secondaryButton} onClick={addRole}>
            添加角色
          </button>
        </div>
      </section>

      <section className={css.section}>
        <header className={css.sectionHead}>
          <span className={css.sectionTitle}>费用与规模上限</span>
        </header>
        <div className={css.grid}>
          <div className={css.cell}>
            <label className={css.label} htmlFor="at-settings-max-tokens">单次输出上限（tokens）</label>
            <input
              id="at-settings-max-tokens"
              className={fieldClass(draft.memberMaxTokens !== undefined && (draft.memberMaxTokens <= 0 || !Number.isSafeInteger(draft.memberMaxTokens)))}
              type="number"
              min={1}
              placeholder="不限制"
              value={draft.memberMaxTokens ?? ''}
              onChange={(event) => { setDraft((previous) => ({ ...previous, memberMaxTokens: optionalInt(event.target.value) })) }}
            />
          </div>
          <div className={css.cell}>
            <label className={css.label} htmlFor="at-settings-max-members">团队人数上限</label>
            <input
              id="at-settings-max-members"
              className={css.input}
              type="number"
              min={1}
              placeholder="默认 8"
              value={draft.maxMembers ?? ''}
              onChange={(event) => { setDraft((previous) => ({ ...previous, maxMembers: optionalInt(event.target.value) })) }}
            />
          </div>
          <div className={css.cell}>
            <label className={css.label} htmlFor="at-settings-max-depth">成员再委派深度</label>
            <input
              id="at-settings-max-depth"
              className={css.input}
              type="number"
              min={0}
              placeholder="默认 1"
              value={draft.memberMaxDepth ?? ''}
              onChange={(event) => { setDraft((previous) => ({ ...previous, memberMaxDepth: optionalInt(event.target.value) })) }}
            />
          </div>
        </div>
      </section>

      {(localError !== '' || state.error !== '' || state.saveError !== '') && (
        <p className={css.error} role="alert">{localError || state.saveError || state.error}</p>
      )}

      <div className={css.actions}>
        <button
          type="button"
          className={css.secondaryButton}
          onClick={reset}
          disabled={state.saving}
        >
          清空表单
        </button>
        <button
          type="button"
          className={css.secondaryButton}
          onClick={resetAndSave}
          disabled={state.saving}
        >
          恢复默认
        </button>
        <button
          type="button"
          className={css.primaryButton}
          onClick={save}
          disabled={state.saving}
        >
          {state.saving ? '保存中…' : '保存设置'}
        </button>
      </div>
    </div>
  )
}
