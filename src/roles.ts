/**
 * Built-in sub-agent role definitions shared by the host (persona + model
 * routing) and the browser (settings panel). Pure data, zero imports — both
 * programs load this module.
 *
 * A member's free-form `role` string is matched against these keys (and any
 * custom keys the user adds in the settings panel) to pick the per-role model
 * route and, when configured, the role's persona description. The set mirrors
 * the whale artwork buckets plus the common `reviewer` role, so role names
 * stay consistent across surfaces.
 * @module dsh-agent-teams/roles
 */

/** One selectable sub-agent role type. */
export interface RoleDefinition {
  /** Canonical key used as the settings `roleModels` map key. */
  readonly key: string
  /** Human-readable name for the settings panel. */
  readonly name: string
  /** Default persona description (role definition) shown/used when the user
   * has not overridden it in the settings panel. */
  readonly description: string
}

/** Built-in role catalog shown in the settings panel. */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    key: 'researcher',
    name: '研究员 · Researcher',
    description: '你是一名研究员，负责资料调研、方案探索与竞品/源码分析，输出结构化结论，注重证据与来源。',
  },
  {
    key: 'engineer',
    name: '工程师 · Engineer',
    description: '你是一名工程师，负责功能实现、代码编写与联调，注重正确性、可维护性与测试。',
  },
  {
    key: 'reviewer',
    name: '评审 · Reviewer',
    description: '你是一名评审者，从性能、安全、产品与代码质量等视角审查产出，给出可执行的意见与结论。',
  },
  {
    key: 'qa',
    name: '测试 · QA',
    description: '你是一名测试工程师，负责用例设计、验证与回归，主动发现边界与故障场景。',
  },
  {
    key: 'designer',
    name: '设计 · Designer',
    description: '你是一名设计师，负责交互与视觉方案，注重一致性与可访问性。',
  },
  {
    key: 'security',
    name: '安全 · Security',
    description: '你是一名安全工程师，负责风险、威胁与安全审计，给出加固建议。',
  },
  {
    key: 'docs',
    name: '文档 · Docs',
    description: '你是一名文档工程师，负责说明文档、规范与示例的撰写，注重准确与可读。',
  },
  {
    key: 'data',
    name: '数据 · Data',
    description: '你是一名数据分析师，负责指标、性能与数据的分析，结论基于可复现的数据。',
  },
  {
    key: 'operator',
    name: '运维 · Operator',
    description: '你是一名运维工程师，负责构建、发布与部署，注重可观测性与回滚安全。',
  },
]
