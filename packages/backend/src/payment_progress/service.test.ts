import { v4 as uuid } from 'uuid'
import Knex from 'knex'
//import { WorkerUtils, makeWorkerUtils } from 'graphile-worker'

import { PaymentProgressService } from './service'
import { createTestApp, TestContainer } from '../tests/app'
//import { resetGraphileDb } from '../tests/graphileDb'
//import { GraphileProducer } from '../messaging/graphileProducer'
import { Config } from '../config/app'
import { IocContract } from '@adonisjs/fold'
import { initIocContainer } from '../'
import { AppServices } from '../app'
import { truncateTables } from '../tests/tableManager'

describe('PaymentProgressService', (): void => {
  let deps: IocContract<AppServices>
  let appContainer: TestContainer
  //let workerUtils: WorkerUtils
  let paymentProgressService: PaymentProgressService
  let knex: Knex
  //const messageProducer = new GraphileProducer()
  //const mockMessageProducer = {
  //  send: jest.fn()
  //}

  beforeAll(
    async (): Promise<void> => {
      deps = await initIocContainer(Config)
      //deps.bind('messageProducer', async () => mockMessageProducer)
      appContainer = await createTestApp(deps)
      //workerUtils = await makeWorkerUtils({
      //  connectionString: appContainer.connectionUrl
      //})
      //await workerUtils.migrate()
      //messageProducer.setUtils(workerUtils)
      knex = await deps.use('knex')
    }
  )

  beforeEach(
    async (): Promise<void> => {
      paymentProgressService = await deps.use('paymentProgressService')
    }
  )

  afterAll(
    async (): Promise<void> => {
      await appContainer.shutdown()
      //await workerUtils.release()
      //await resetGraphileDb(knex)
      await truncateTables(knex)
    }
  )

  describe('create', (): void => {
    it('creates a PaymentProgress', async () => {
      const id = uuid()
      const progress = await paymentProgressService.create(id)
      expect(progress.amountSent).toEqual(BigInt(0))
      expect(progress.amountDelivered).toEqual(BigInt(0))

      const progress2 = await paymentProgressService.get(id)
      if (!progress2) throw new Error()
      expect(progress2.id).toEqual(id)
    })
  })
})
