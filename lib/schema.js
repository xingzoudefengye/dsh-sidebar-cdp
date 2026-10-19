/**
 * 作者写法的 schema → 工具注册表要的 JSON Schema，外加一次参数校验。
 *
 * 为什么自己写这 40 行而不 import @deepseek-ai/dsh-tools：外部插件的依赖是在
 * 它自己的目录里解析的，host 的 node_modules 不在解析路径上（实测：从 profile
 * 目录 import 该包直接 ERR_MODULE_NOT_FOUND）。插件因此只依赖 node: 内建模块，
 * 装到哪个 profile、哪台机器都能解析。
 *
 * 支持的作者写法与官方 defineTool 一致：属性上的 required: true 会被提成父节点
 * 的 required 数组；其余关键字原样透传。
 */

/** 作者写法 → 标准 JSON Schema（递归处理 properties / items）。 */
export function toJsonSchema(spec) {
  if (Array.isArray(spec)) return spec.map(toJsonSchema)
  if (spec === null || typeof spec !== 'object') return spec

  const node = {}
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required' && typeof value === 'boolean') continue
    if (key === 'properties' && value && typeof value === 'object') {
      const properties = {}
      const required = []
      for (const [name, property] of Object.entries(value)) {
        properties[name] = toJsonSchema(property)
        if (property && property.required === true) required.push(name)
      }
      node.properties = properties
      if (required.length > 0) node.required = required
      continue
    }
    if (key === 'items') {
      node.items = toJsonSchema(value)
      continue
    }
    node[key] = value
  }
  return node
}

const TYPE_CHECK = {
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
}

/**
 * 校验模型给的参数；返回违规清单，空数组表示合法。
 * 只覆盖本插件用到的关键字：type / required / items / properties / enum。
 */
export function validateArgs(schema, value, path = '') {
  const violations = []
  if (schema.type && TYPE_CHECK[schema.type] && !TYPE_CHECK[schema.type](value)) {
    violations.push(`${path || '(root)'} 应为 ${schema.type}`)
    return violations
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path || '(root)'} 只允许 ${schema.enum.join(' / ')}`)
  }
  if (schema.type === 'object' && schema.properties) {
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) violations.push(`${path ? `${path}.` : ''}${name} 缺失`)
    }
    for (const [name, property] of Object.entries(schema.properties)) {
      if (value[name] !== undefined) {
        violations.push(...validateArgs(property, value[name], path ? `${path}.${name}` : name))
      }
    }
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, index) => {
      violations.push(...validateArgs(schema.items, item, `${path}[${index}]`))
    })
  }
  return violations
}

/**
 * 与官方 defineTool 同形的最小实现：编译 schema、校验参数、转调 execute。
 * @param options 工具定义（作者写法）。
 */
export function defineTool(options) {
  const parameters = toJsonSchema({ type: 'object', properties: options.parameters ?? {} })
  const output = { schema: toJsonSchema(options.output.schema), render: options.output.render }
  if (options.timeoutMs !== undefined && !(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs 必须是正数`)
  }
  return {
    name: options.name,
    description: options.description,
    parameters,
    output,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validateArgs(parameters, args ?? {})
      if (violations.length > 0) throw new Error(`参数不合法：${violations.join('；')}`)
      return options.execute(args, exec)
    },
  }
}
