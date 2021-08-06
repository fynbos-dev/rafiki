import nock from 'nock'
import Knex from 'knex'
import { StreamServer } from '@interledger/stream-receiver'
import {
  deserializeIlpPrepare,
  isIlpReply,
  serializeIlpReply,
  serializeIlpFulfill
} from 'ilp-packet'
import { serializeIldcpResponse } from 'ilp-protocol-ildcp'

import { OutgoingPaymentService } from './service'
import { createTestApp, TestContainer } from '../tests/app'
import { Config } from '../config/app'
import { IocContract } from '@adonisjs/fold'
import { initIocContainer } from '../'
import { AppServices } from '../app'
import { truncateTables } from '../tests/tableManager'
import { MockAccountService } from '../tests/mockAccounts'
import { PaymentState } from './model'
import { IlpPlugin } from './ilp_plugin'

class MockPlugin implements IlpPlugin {
  constructor(private server: StreamServer) {}
  connect(): Promise<void> {
    return Promise.resolve()
  }
  disconnect(): Promise<void> {
    return Promise.resolve()
  }
  isConnected(): boolean {
    return true
  }

  async sendData(data: Buffer): Promise<Buffer> {
    // First, handle the initial IL-DCP request when the connection is created
    const prepare = deserializeIlpPrepare(data)
    if (prepare.destination === 'peer.config') {
      return serializeIldcpResponse({
        clientAddress: 'test.wallet',
        assetCode: 'XRP',
        assetScale: 9
      })
    } else {
      const moneyOrReject = this.server.createReply(prepare)
      if (isIlpReply(moneyOrReject)) {
        return serializeIlpReply(moneyOrReject)
      }

      moneyOrReject.setTotalReceived(prepare.amount)
      return serializeIlpFulfill(moneyOrReject.accept())
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  registerDataHandler(_handler: (data: Buffer) => Promise<Buffer>): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  deregisterDataHandler(): void {}
}

describe('OutgoingPaymentService', (): void => {
  let deps: IocContract<AppServices>
  let appContainer: TestContainer
  let outgoingPaymentService: OutgoingPaymentService
  let accountService: MockAccountService
  let knex: Knex
  let superAccountId: string

  const streamServer = new StreamServer({
    serverSecret: Buffer.from(
      '61a55774643daa45bec703385ea6911dbaaaa9b4850b77884f2b8257eef05836',
      'hex'
    ),
    serverAddress: 'test.bobwallet'
  })
  const credentials = streamServer.generateCredentials({
    asset: {
      code: 'XRP',
      scale: 9
    }
  })

  beforeAll(
    async (): Promise<void> => {
      deps = await initIocContainer(Config)
      deps.bind('ilpPlugin', async (_deps) => new MockPlugin(streamServer))
      deps.bind(
        'accountService2',
        async (_deps) => (accountService = new MockAccountService())
      ) // XXX 2
      appContainer = await createTestApp(deps)
      knex = await deps.use('knex')
    }
  )

  beforeEach(
    async (): Promise<void> => {
      nock.cleanAll()
      outgoingPaymentService = await deps.use('outgoingPaymentService')
      superAccountId = (await accountService.create(9, 'USD')).id
    }
  )

  afterAll(
    async (): Promise<void> => {
      await appContainer.shutdown()
      await truncateTables(knex)
    }
  )

  describe('create', (): void => {
    it('creates an OutgoingPayment', async () => {
      nock('http://bob.example')
        .get('/pay')
        .reply(200, {
          destination_account: credentials.ilpAddress,
          shared_secret: credentials.sharedSecret.toString('base64')
        })
      //{
      //  destination_account: 'test.bob',
      //  shared_secret: Buffer.alloc(32).toString('base64')
      //})

      const payment = await outgoingPaymentService.create({
        superAccountId,
        paymentPointer: 'http://bob.example/pay',
        //invoiceUrl?: string
        amountToSend: BigInt(123),
        autoApprove: false
      })
      expect(payment.state).toEqual(PaymentState.Inactive)
      expect(payment.intent).toEqual({
        paymentPointer: 'http://bob.example/pay',
        amountToSend: BigInt(123),
        autoApprove: false
      })
      await expect(
        accountService.getAccountBalance(payment.sourceAccount.id)
      ).resolves.toEqual({ balance: BigInt(0) })
      expect(payment.sourceAccount.code).toBe('USD')
      expect(payment.sourceAccount.scale).toBe(9)
      expect(payment.destinationAccount).toEqual({
        scale: 9,
        code: 'XRP',
        url: 'http://bob.example/pay'
      })

      const payment2 = await outgoingPaymentService.get(payment.id)
      expect(payment2.id).toEqual(payment.id)
      //const id = uuid()
      //const progress = await outgoingPaymentService.create(id)
      //expect(progress.amountSent).toEqual(BigInt(0))
      //expect(progress.amountDelivered).toEqual(BigInt(0))

      //const progress2 = await outgoingPaymentService.get(id)
      //if (!progress2) throw new Error
      //expect(progress2.id).toEqual(id)
    })
  })
})
