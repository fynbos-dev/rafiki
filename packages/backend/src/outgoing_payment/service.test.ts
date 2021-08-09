import nock from 'nock'
import Knex from 'knex'
import * as Pay from '@interledger/pay'
import { StreamServer } from '@interledger/stream-receiver'

import { OutgoingPaymentService } from './service'
import { createTestApp, TestContainer } from '../tests/app'
import { Config } from '../config/app'
import { IocContract } from '@adonisjs/fold'
import { initIocContainer } from '../'
import { AppServices } from '../app'
import { truncateTables } from '../tests/tableManager'
import { MockAccountService } from '../tests/mockAccounts'
import { OutgoingPayment, PaymentState } from './model'
import { MockPlugin } from './mock_plugin'
import { LifecycleError } from './lifecycle'

// TODO test that balance is refunded properly

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
      deps.bind('ilpPlugin', async (_deps) => new MockPlugin(streamServer, 0.5))
      deps.bind(
        'accountService2',
        async (_deps) => (accountService = new MockAccountService())
      ) // XXX 2
      deps.bind('ratesService', async (_deps) => ({
        prices: async () => ({
          USD: 1.0,
          XRP: 2.0
        })
      }))
      appContainer = await createTestApp(deps)
      knex = await deps.use('knex')
    }
  )

  beforeEach(
    async (): Promise<void> => {
      outgoingPaymentService = await deps.use('outgoingPaymentService')
      superAccountId = (await accountService.create(9, 'USD')).id
      accountService.setAccountBalance(superAccountId, BigInt(200))

      nock('http://bob.example')
        .get('/pay')
        .reply(200, {
          destination_account: credentials.ilpAddress,
          shared_secret: credentials.sharedSecret.toString('base64')
        })
        .persist()
      await knex.raw('TRUNCATE TABLE "outgoingPayments" RESTART IDENTITY')
    }
  )

  afterEach((): void => {
    nock.cleanAll()
    jest.useRealTimers()
  })

  afterAll(
    async (): Promise<void> => {
      await appContainer.shutdown()
      await truncateTables(knex)
    }
  )

  describe('create', (): void => {
    it('creates an OutgoingPayment', async () => {
      const payment = await outgoingPaymentService.create({
        superAccountId,
        paymentPointer: 'http://bob.example/pay',
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
    })
  })

  describe('processNext', (): void => {
    describe('Inactive →', (): void => {
      it('Ready (paymentPointer)', async (): Promise<void> => {
        const paymentId = (
          await outgoingPaymentService.create({
            superAccountId,
            paymentPointer: 'http://bob.example/pay',
            amountToSend: BigInt(123),
            autoApprove: false
          })
        ).id
        await expect(outgoingPaymentService.processNext()).resolves.toBe(
          paymentId
        )
        const payment = await OutgoingPayment.query(knex).findById(paymentId)

        expect(payment.state).toEqual(PaymentState.Ready)
        if (!payment.quote) throw 'no quote'
        expect(payment.quote.timestamp).toBeInstanceOf(Date)
        expect(
          payment.quote.activationDeadline.getTime() - Date.now()
        ).toBeGreaterThan(0)
        expect(payment.quote.targetType).toBe(Pay.PaymentType.FixedSend)
        expect(payment.quote.minDeliveryAmount).toBe(
          BigInt(Math.ceil(123 * payment.quote.minExchangeRate.valueOf()))
        )
        expect(payment.quote.maxSourceAmount).toBe(BigInt(123))
        expect(payment.quote.maxPacketAmount).toBe(
          BigInt('9223372036854775807')
        )
        expect(payment.quote.minExchangeRate.valueOf()).toBe(
          0.5 * (1 - Config.slippage)
        )
        expect(payment.quote.lowExchangeRateEstimate.valueOf()).toBe(0.5)
        expect(payment.quote.highExchangeRateEstimate.valueOf()).toBe(0.5)
      })
    })

    describe('Ready →', (): void => {
      async function setup({
        autoApprove
      }: {
        autoApprove: boolean
      }): Promise<string> {
        const paymentId = (
          await outgoingPaymentService.create({
            superAccountId,
            paymentPointer: 'http://bob.example/pay',
            amountToSend: BigInt(123),
            autoApprove
          })
        ).id
        // Inactive → Ready
        await expect(outgoingPaymentService.processNext()).resolves.toBe(
          paymentId
        )
        return paymentId
      }

      it('Cancelling (quote expired; autoApprove=false)', async (): Promise<void> => {
        const paymentId = await setup({ autoApprove: false })
        jest.useFakeTimers('modern')
        jest.advanceTimersByTime(Config.quoteLifespan + 1)
        await expect(outgoingPaymentService.processNext()).resolves.toBe(
          paymentId
        )

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe(LifecycleError.QuoteExpired)
      })

      it('Ready (autoApprove=false)', async (): Promise<void> => {
        await setup({ autoApprove: false })
        // (no change)
        await expect(
          outgoingPaymentService.processNext()
        ).resolves.toBeUndefined()
      })

      it('Activated (autoApprove=true)', async (): Promise<void> => {
        const paymentId = await setup({ autoApprove: true })
        await expect(outgoingPaymentService.processNext()).resolves.toBe(
          paymentId
        )

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Activated)
      })
    })

    describe('Activated →', (): void => {
      let paymentId: string

      beforeEach(
        async (): Promise<void> => {
          paymentId = (
            await outgoingPaymentService.create({
              superAccountId,
              paymentPointer: 'http://bob.example/pay',
              amountToSend: BigInt(123),
              autoApprove: true
            })
          ).id
          // Inactive → Ready
          await expect(outgoingPaymentService.processNext()).resolves.toBe(
            paymentId
          )
          // Ready → Activated
          await expect(outgoingPaymentService.processNext()).resolves.toBe(
            paymentId
          )
        }
      )

      it('Cancelling (quote expired)', async (): Promise<void> => {
        jest.useFakeTimers('modern')
        jest.advanceTimersByTime(Config.quoteLifespan + 1)
        await expect(outgoingPaymentService.processNext()).resolves.toBe(
          paymentId
        )

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe(LifecycleError.QuoteExpired)
      })

      it('Cancelling (insufficient balance)', async (): Promise<void> => {
        accountService.setAccountBalance(superAccountId, BigInt(100))
        await expect(outgoingPaymentService.processNext()).resolves.toBe(
          paymentId
        )

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe(LifecycleError.InsufficientBalance)
      })

      it('Cancelling (account service error)', async (): Promise<void> => {
        const mockFn = jest
          .spyOn(accountService, 'extendCredit')
          .mockImplementation(async () => 'FooError')
        await expect(outgoingPaymentService.processNext()).resolves.toBe(
          paymentId
        )
        mockFn.mockRestore()

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe(LifecycleError.AccountServiceError)
      })

      it('Sending', async (): Promise<void> => {
        await expect(outgoingPaymentService.processNext()).resolves.toBe(
          paymentId
        )

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Sending)
        if (!payment.quote) throw 'no quote'
        await expect(
          accountService.getAccountBalance(payment.sourceAccount.id)
        ).resolves.toEqual({ balance: BigInt(payment.quote.maxSourceAmount) })
      })
    })
  })
})
