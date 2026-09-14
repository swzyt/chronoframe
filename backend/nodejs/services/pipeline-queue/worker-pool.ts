import type { ConsolaInstance } from 'consola'
import { consola } from 'consola'
import { and, eq, sql } from 'drizzle-orm'
import { useDB, tables } from '#server/utils/db'
import { publishPipelineWorkerTelemetry } from '#server/utils/pipeline-telemetry'
import { QueueManager } from './manager'
import {
  enqueuePipelineTask,
  type EnqueuePipelineTaskOptions,
  type PipelineQueuePayload,
} from './repository'

export interface WorkerPoolConfig {
  /** 工作器数量 */
  workerCount: number
  /** 轮询间隔（毫秒） */
  intervalMs: number
  /** 工作器间隔偏移（毫秒），用于错开轮询时间 */
  intervalOffset: number
  /** 是否启用负载均衡 */
  enableLoadBalancing: boolean
  /** 统计报告间隔（毫秒） */
  statsReportInterval: number
  /** 停止时等待单个工作器完成在途任务的最长时间（毫秒） */
  shutdownTimeoutMs: number
}

export interface WorkerStats {
  workerId: string
  isProcessing: boolean
  processedCount: number
  errorCount: number
  uptime: number
  successRate: number
}

export interface PoolStats {
  totalWorkers: number
  activeWorkers: number
  totalProcessed: number
  totalErrors: number
  averageSuccessRate: number
  workers: WorkerStats[]
}

/**
 * 工作器池
 */
export class WorkerPool {
  private workers: QueueManager[] = []
  private logger: ConsolaInstance
  private config: WorkerPoolConfig
  private statsInterval: NodeJS.Timeout | null = null
  private telemetryInterval: NodeJS.Timeout | null = null
  private rebalanceRestartTimers: Set<NodeJS.Timeout> = new Set()
  private isRunning: boolean = false

  constructor(config: Partial<WorkerPoolConfig>, logger?: ConsolaInstance) {
    this.config = {
      workerCount: 3,
      intervalMs: 2000,
      intervalOffset: 300,
      enableLoadBalancing: true,
      statsReportInterval: 30000,
      shutdownTimeoutMs: 30000,
      ...config,
    }
    this.logger = logger || consola.withTag('worker-pool')
  }

  /**
   * 启动工作器池
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('WorkerPool is already running')
      return
    }

    this.logger.info(
      `Starting WorkerPool with ${this.config.workerCount} workers`,
    )

    // 在启动工作器之前，清理死任务
    await this.cleanupDeadTasks()

    // 创建工作器
    for (let i = 1; i <= this.config.workerCount; i++) {
      const workerId = `worker-${i}`
      const worker = QueueManager.getInstance(workerId, this.logger)

      // 错开时间以减少数据库竞争
      const workerInterval =
        this.config.intervalMs + (i - 1) * this.config.intervalOffset

      this.workers.push(worker)
      worker.startProcessing(workerInterval)
    }

    this.isRunning = true

    // 启动统计报告
    if (this.config.statsReportInterval > 0) {
      this.startStatsReporting()
    }
    this.startTelemetryPublishing()

    this.logger.success(
      `WorkerPool started successfully with ${this.workers.length} workers`,
    )
  }

  /**
   * 停止工作器池
   */
  async stop(): Promise<boolean> {
    if (!this.isRunning) {
      this.logger.warn('WorkerPool is not running')
      return true
    }

    this.logger.info('Stopping WorkerPool...')
    this.isRunning = false

    // 停止统计报告
    if (this.statsInterval) {
      clearInterval(this.statsInterval)
      this.statsInterval = null
    }
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval)
      this.telemetryInterval = null
    }

    for (const timer of this.rebalanceRestartTimers) {
      clearTimeout(timer)
    }
    this.rebalanceRestartTimers.clear()

    // 停止所有工作器
    const drainResults = await Promise.all(
      this.workers.map(async (worker, _index) => {
        try {
          const drained = await worker.stopProcessing(
            this.config.shutdownTimeoutMs,
          )
          if (drained) {
            this.logger.info(`worker [${worker.getWorkerId()}] stopped`)
          } else {
            this.logger.warn(
              `worker [${worker.getWorkerId()}] stopped polling with an in-flight task still running`,
            )
          }
          return drained
        } catch (error) {
          this.logger.error(
            `Error stopping worker [${worker.getWorkerId()}]:`,
            error,
          )
          return false
        }
      }),
    )
    const drained = drainResults.every(Boolean)

    if (drained) {
      this.workers = []
    }
    await this.publishTelemetrySnapshot().catch((error) => {
      this.logger.warn(
        'Failed to publish final worker telemetry snapshot',
        error,
      )
    })

    if (drained) {
      this.logger.success('WorkerPool stopped successfully')
    } else {
      this.logger.warn(
        'WorkerPool stopped polling but still has in-flight work; runtime lease must remain held',
      )
    }
    return drained
  }

  /**
   * 获取池统计信息
   */
  getPoolStats(): PoolStats {
    const workerStats = this.workers.map((worker) => worker.getStats())

    const totalProcessed = workerStats.reduce(
      (sum, stats) => sum + stats.processedCount,
      0,
    )
    const totalErrors = workerStats.reduce(
      (sum, stats) => sum + stats.errorCount,
      0,
    )
    const activeWorkers = workerStats.filter(
      (stats) => stats.isProcessing,
    ).length

    // 只计算已执行过操作的worker的平均成功率
    const workersWithActivity = workerStats.filter(
      (stats) => stats.processedCount > 0,
    )
    const averageSuccessRate =
      workersWithActivity.length > 0
        ? workersWithActivity.reduce(
            (sum, stats) => sum + stats.successRate,
            0,
          ) / workersWithActivity.length
        : 0

    return {
      totalWorkers: this.workers.length,
      activeWorkers,
      totalProcessed,
      totalErrors,
      averageSuccessRate: Math.round(averageSuccessRate * 100) / 100,
      workers: workerStats,
    }
  }

  /**
   * 启动控制台统计报告
   */
  private startStatsReporting(): void {
    this.statsInterval = setInterval(() => {
      const stats = this.getPoolStats()

      this.logger.info('=== WorkerPool Stats ===')
      this.logger.info(
        `Total Workers: ${stats.totalWorkers}, Active: ${stats.activeWorkers}`,
      )
      this.logger.info(
        `Total Processed: ${stats.totalProcessed}, Total Errors: ${stats.totalErrors}`,
      )
      this.logger.info(`Average Success Rate: ${stats.averageSuccessRate}%`)

      stats.workers.forEach((worker) => {
        const status = worker.isProcessing ? 'Processing' : 'Idle'
        this.logger.info(
          `  ${worker.workerId}: ${status} | Processed: ${worker.processedCount} | Errors: ${worker.errorCount} | Success Rate: ${worker.successRate.toFixed(1)}% | Uptime: ${worker.uptime}s`,
        )
      })
    }, this.config.statsReportInterval)
  }

  private startTelemetryPublishing(): void {
    const publish = () => {
      void this.publishTelemetrySnapshot().catch((error) => {
        this.logger.warn('Failed to publish worker telemetry snapshot', error)
      })
    }
    publish()
    this.telemetryInterval = setInterval(publish, 10_000)
  }

  private async publishTelemetrySnapshot(): Promise<void> {
    const queueStats = await this.getQueueStats()
    await publishPipelineWorkerTelemetry({
      timestamp: new Date().toISOString(),
      backend: 'node',
      pool: {
        isActive: this.isActive(),
        workerCount: this.getWorkerCount(),
        ...this.getPoolStats(),
      },
      queue: queueStats,
    })
  }

  /**
   * 重新平衡工作器负载
   */
  async rebalance(): Promise<void> {
    if (!this.isRunning || !this.config.enableLoadBalancing) {
      return
    }

    const stats = this.getPoolStats()

    // 如果某个工作器错误率过高，重启它
    const problematicWorkers = stats.workers.filter(
      (worker) => worker.errorCount > 10 && worker.successRate < 50,
    )

    for (const workerStat of problematicWorkers) {
      this.logger.warn(
        `Worker ${workerStat.workerId} has high error rate, preparing to restart`,
      )

      const worker = this.workers.find(
        (w) => w.getWorkerId() === workerStat.workerId,
      )
      if (worker) {
        await worker.stopProcessing(this.config.shutdownTimeoutMs)
        if (!this.isRunning) {
          return
        }

        const restartTimer = setTimeout(() => {
          this.rebalanceRestartTimers.delete(restartTimer)
          if (!this.isRunning) {
            return
          }

          worker.startProcessing(this.config.intervalMs)
          this.logger.info(`Worker ${workerStat.workerId} has been restarted`)
        }, 5000)
        this.rebalanceRestartTimers.add(restartTimer)
      }
    }
  }

  /**
   * 获取队列统计信息（从任意一个工作器获取）
   */
  async getQueueStats() {
    if (this.workers.length === 0) {
      const stats = await useDB()
        .select({
          status: tables.pipelineQueue.status,
          count: sql<number>`COUNT(*)`,
        })
        .from(tables.pipelineQueue)
        .groupBy(tables.pipelineQueue.status)

      return stats.reduce(
        (acc, stat) => {
          acc[stat.status] = stat.count
          return acc
        },
        {} as Record<string, number>,
      )
    }

    return await this.workers[0]!.getQueueStats()
  }

  /**
   * 清理死任务 - 只回收已经过期的 in-stages lease。
   */
  private async cleanupDeadTasks(): Promise<void> {
    try {
      const db = useDB()
      const expiredLeaseCondition = and(
        eq(tables.pipelineQueue.status, 'in-stages'),
        sql`(${tables.pipelineQueue.claimExpiresAt} IS NULL OR ${tables.pipelineQueue.claimExpiresAt} <= (unixepoch()))`,
      )

      // 查找 lease 过期的 in-stages 任务（这些可能是死任务）
      const deadTasks = await db
        .select({ id: tables.pipelineQueue.id })
        .from(tables.pipelineQueue)
        .where(expiredLeaseCondition)

      if (deadTasks.length > 0) {
        this.logger.warn(
          `Found ${deadTasks.length} expired queue task leases, resetting them to pending`,
        )

        // 将过期任务重置为 pending 状态，清除状态阶段和 claim 信息
        await db
          .update(tables.pipelineQueue)
          .set({
            status: 'pending',
            statusStage: null,
            claimedBy: null,
            claimToken: null,
            claimExpiresAt: null,
            availableAt: sql`(unixepoch())`,
          })
          .where(expiredLeaseCondition)

        this.logger.success(
          `Successfully reset ${deadTasks.length} expired queue task leases to pending status`,
        )
      } else {
        this.logger.info('No expired queue task leases found')
      }
    } catch (error) {
      this.logger.error('Failed to cleanup dead tasks:', error)
      // 不抛出错误，允许工作器池继续启动
    }
  }

  /**
   * 检查池是否正在运行
   */
  isActive(): boolean {
    return this.isRunning
  }

  /**
   * 获取工作器数量
   */
  getWorkerCount(): number {
    return this.workers.length
  }

  /** 获取第一个工作器 */
  getFirstWorker(): QueueManager | null {
    return this.workers[0] ?? null
  }

  /** 添加任务到队列（兼容入口，入库不依赖工作器） */
  async addTask(
    payload: PipelineQueuePayload,
    options: EnqueuePipelineTaskOptions,
  ): Promise<number> {
    return await enqueuePipelineTask(payload, options)
  }

  /**
   * 获取任务状态
   * @param taskId 任务ID
   * @returns 任务状态信息
   */
  async getTaskStatus(taskId: number) {
    const worker = this.getFirstWorker()
    if (!worker) {
      throw new Error('No workers available')
    }
    return await worker.getTaskStatus(taskId)
  }
}
