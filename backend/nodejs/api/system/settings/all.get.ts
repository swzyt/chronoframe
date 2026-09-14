import { useDB, tables, eq, or, and } from '#server/utils/db'
import { decodeSettingValue } from '#server/utils/settings-value'

/**
 * 获取所有公开设置
 * 仅返回 isPublic=true 的设置，按命名空间分组
 * 特例：始终返回 system:firstLaunch 以便前端判断是否需要初始化
 */
export default eventHandler(async () => {
  const db = useDB()

  // 查询所有公开设置
  const allSettings = db
    .select()
    .from(tables.settings)
    .where(
      or(
        eq(tables.settings.isPublic, true),
        and(
          eq(tables.settings.namespace, 'system'),
          eq(tables.settings.key, 'firstLaunch'),
        ),
      ),
    )
    .all()

  // 按命名空间分组
  const grouped: Record<string, Record<string, any>> = {}

  for (const setting of allSettings) {
    const namespace = grouped[setting.namespace] ?? {}
    grouped[setting.namespace] = namespace

    namespace[setting.key] = decodeSettingValue(setting.type, setting.value)
  }

  return {
    timestamp: Date.now(),
    data: grouped,
  }
})
