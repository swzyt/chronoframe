import {
  isNodeOwner,
  runtimeOwnership,
} from '#server/utils/runtime-ownership'
import {
  acquireRuntimeLease,
  type RuntimeLeaseHandle,
} from '#server/utils/runtime-lease'

export default defineNitroPlugin(async (nitroApp) => {
  const _logger = logger.dynamic('queue')
  const { pipelineConsumer } = runtimeOwnership

  if (!isNodeOwner(pipelineConsumer)) {
    globalThis.__workerPool = undefined
    _logger.info(
      `Skipping Node pipeline consumer because CFRAME_PIPELINE_CONSUMER=${pipelineConsumer}`,
    )
    return
  }

  const { WorkerPool } = await import('../services/pipeline-queue/worker-pool')
  const workerPool = new WorkerPool(
    {
      workerCount: 5,
      intervalMs: 1500,
      intervalOffset: 300,
      enableLoadBalancing: true,
      statsReportInterval: 60000 * 10,
    },
    _logger,
  )
  let lease: RuntimeLeaseHandle | null = null
  let rebalanceTimer: NodeJS.Timeout | null = null
  let shutdownPromise: Promise<void> | null = null

  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        if (rebalanceTimer) {
          clearInterval(rebalanceTimer)
          rebalanceTimer = null
        }

        _logger.info('Shutting down worker pool...')
        const drained = await workerPool.stop()

        if (globalThis.__workerPool === workerPool) {
          globalThis.__workerPool = undefined
        }

        if (drained) {
          await lease?.release().catch((error) => {
            _logger.warn(
              'Failed to release Node pipeline consumer lease',
              error,
            )
          })
          lease = null
        } else {
          _logger.warn(
            'Keeping the Node pipeline consumer lease until process exit because in-flight work did not drain',
          )
        }
      })()
    }

    return shutdownPromise
  }

  nitroApp.hooks.hook('close', shutdown)

  lease = await acquireRuntimeLease({
    actor: 'pipeline-consumer',
    owner: 'node',
    onLost(error) {
      _logger.error(
        'Node pipeline consumer lease lost; stopping workers',
        error,
      )
      void shutdown()
    },
  })
  if (!lease.acquired) {
    _logger.error(
      `Skipping Node pipeline consumer because runtime lease ${lease.key} is already held`,
    )
    return
  }
  if (!lease.enabled) {
    _logger.warn(
      'Starting Node pipeline consumer without Redis runtime lease because shared Redis is not configured',
    )
  }

  try {
    await workerPool.start()
    globalThis.__workerPool = workerPool
  } catch (error) {
    await lease.release().catch((releaseError) => {
      _logger.warn(
        'Failed to release Node pipeline consumer lease',
        releaseError,
      )
    })
    lease = null
    throw error
  }

  // 每 5 分钟进行一次负载均衡检查
  rebalanceTimer = setInterval(
    async () => {
      try {
        await workerPool.rebalance()
      } catch (error) {
        _logger.error('Rebalance failed:', error)
      }
    },
    5 * 60 * 1000,
  )
})
