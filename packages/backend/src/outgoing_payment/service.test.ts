import nock from 'nock'
import Knex from 'knex'
import * as Pay from '@interledger/pay'
import { StreamServer, StreamCredentials } from '@interledger/stream-receiver'

import { OutgoingPaymentService } from './service'
import { createTestApp, TestContainer } from '../tests/app'
import { Config } from '../config/app'
import { IocContract } from '@adonisjs/fold'
import { initIocContainer } from '../'
import { AppServices } from '../app'
import { truncateTables } from '../tests/tableManager'
import { MockAccountService } from '../tests/mockAccounts'
import { OutgoingPayment, PaymentIntent, PaymentState } from './model'
import { MockPlugin } from './mock_plugin'
import { LifecycleError } from './lifecycle'
import { PaymentProgressService } from '../payment_progress/service'

// TODO test that balance is refunded properly on COMPLETION
// TODO test that balance is refunded properly on CANCELLATION
// TODO test restart sending from partial payment
// TODO test quote FixedDestination + invoice
// TODO test retry states, attempts increment

describe('OutgoingPaymentService', (): void => {
  let deps: IocContract<AppServices>
  let appContainer: TestContainer
  let outgoingPaymentService: OutgoingPaymentService
  let paymentProgressService: PaymentProgressService
  let accountService: MockAccountService
  let knex: Knex
  let superAccountId: string
  let credentials: StreamCredentials
  const plugins: { [sourceAccount: string]: MockPlugin } = {}

  const streamServer = new StreamServer({
    serverSecret: Buffer.from(
      '61a55774643daa45bec703385ea6911dbaaaa9b4850b77884f2b8257eef05836',
      'hex'
    ),
    serverAddress: 'test.wallet'
  })

  async function processNext(paymentId: string): Promise<void> {
    await expect(outgoingPaymentService.processNext()).resolves.toBe(paymentId)
  }

  beforeAll(
    async (): Promise<void> => {
      accountService = new MockAccountService()
      deps = await initIocContainer(Config)
      deps.bind('makeIlpPlugin', async (_deps) => (sourceAccount: string) =>
        (plugins[sourceAccount] = new MockPlugin({
          streamServer,
          exchangeRate: 0.5,
          sourceAccount,
          accountService
        }))
      )
      deps.bind('accountService2', async (_deps) => accountService) // XXX 2
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
      credentials = streamServer.generateCredentials({
        asset: {
          code: 'XRP',
          scale: 9
        }
      })
      outgoingPaymentService = await deps.use('outgoingPaymentService')
      paymentProgressService = await deps.use('paymentProgressService')
      superAccountId = (await accountService.create(9, 'USD')).id
      accountService.setAccountBalance(superAccountId, BigInt(200))

      nock('http://wallet.example')
        .get('/paymentpointer/bob')
        .reply(200, {
          destination_account: credentials.ilpAddress,
          shared_secret: credentials.sharedSecret.toString('base64')
        })
        .persist()
        .get('/bob/invoices/1')
        .reply(200, {
          id: 'http://wallet.example/bob/invoices/1',
          account: 'http://wallet.example/bob',
          amount: 56,
          assetCode: 'XRP',
          assetScale: 9,
          description: 'description!',
          received: 0,
          expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
          ilpAddress: credentials.ilpAddress,
          sharedSecret: credentials.sharedSecret.toString('base64')
        })
        .persist()
      await knex.raw('TRUNCATE TABLE "outgoingPayments" RESTART IDENTITY')
    }
  )

  afterEach((): void => {
    nock.cleanAll()
    jest.useRealTimers()
    jest.restoreAllMocks()
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
        paymentPointer: 'http://wallet.example/paymentpointer/bob',
        amountToSend: BigInt(123),
        autoApprove: false
      })
      expect(payment.state).toEqual(PaymentState.Inactive)
      expect(payment.intent).toEqual({
        paymentPointer: 'http://wallet.example/paymentpointer/bob',
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
        url: 'http://wallet.example/paymentpointer/bob'
      })

      const payment2 = await outgoingPaymentService.get(payment.id)
      expect(payment2.id).toEqual(payment.id)
    })
  })

  describe('processNext', (): void => {
    describe('Inactive→', (): void => {
      it('Ready (paymentPointer)', async (): Promise<void> => {
        const paymentId = (
          await outgoingPaymentService.create({
            superAccountId,
            paymentPointer: 'http://wallet.example/paymentpointer/bob',
            amountToSend: BigInt(123),
            autoApprove: false
          })
        ).id
        await processNext(paymentId)
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

    describe('Ready→', (): void => {
      async function setup({
        autoApprove
      }: {
        autoApprove: boolean
      }): Promise<string> {
        const paymentId = (
          await outgoingPaymentService.create({
            superAccountId,
            paymentPointer: 'http://wallet.example/paymentpointer/bob',
            amountToSend: BigInt(123),
            autoApprove
          })
        ).id
        await processNext(paymentId) // Inactive → Ready
        return paymentId
      }

      it('Cancelling (quote expired; autoApprove=false)', async (): Promise<void> => {
        const paymentId = await setup({ autoApprove: false })
        jest.useFakeTimers('modern')
        jest.advanceTimersByTime(Config.quoteLifespan + 1)
        await processNext(paymentId)

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
        await processNext(paymentId)

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Activated)
      })
    })

    describe('Activated→', (): void => {
      let paymentId: string

      beforeEach(
        async (): Promise<void> => {
          paymentId = (
            await outgoingPaymentService.create({
              superAccountId,
              paymentPointer: 'http://wallet.example/paymentpointer/bob',
              amountToSend: BigInt(123),
              autoApprove: true
            })
          ).id
          // Inactive → Ready → Activated
          for (let i = 0; i < 2; i++) await processNext(paymentId)
        }
      )

      it('Cancelling (quote expired)', async (): Promise<void> => {
        jest.useFakeTimers('modern')
        jest.advanceTimersByTime(Config.quoteLifespan + 1)
        await processNext(paymentId)

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe(LifecycleError.QuoteExpired)
      })

      it('Cancelling (insufficient balance)', async (): Promise<void> => {
        accountService.setAccountBalance(superAccountId, BigInt(100))
        await processNext(paymentId)

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe(LifecycleError.InsufficientBalance)
      })

      it('Cancelling (account service error)', async (): Promise<void> => {
        const mockFn = jest
          .spyOn(accountService, 'extendCredit')
          .mockImplementation(async () => 'FooError')
        await processNext(paymentId)
        mockFn.mockRestore()

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe(LifecycleError.AccountServiceError)
      })

      it('Sending', async (): Promise<void> => {
        await processNext(paymentId)

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Sending)
        if (!payment.quote) throw 'no quote'
        await expect(
          accountService.getAccountBalance(payment.sourceAccount.id)
        ).resolves.toEqual({ balance: BigInt(payment.quote.maxSourceAmount) })
      })
    })

    describe('Sending→', (): void => {
      async function setup(
        opts: Pick<
          PaymentIntent,
          'amountToSend' | 'paymentPointer' | 'invoiceUrl'
        >
      ): Promise<string> {
        const paymentId = (
          await outgoingPaymentService.create({
            superAccountId,
            autoApprove: true,
            ...opts
          })
        ).id
        // Inactive → Ready → Activated → Sending
        for (let i = 0; i < 3; i++) await processNext(paymentId)
        return paymentId
      }

      it('Completed (FixedSend)', async (): Promise<void> => {
        const paymentId = await setup({
          paymentPointer: 'http://wallet.example/paymentpointer/bob',
          amountToSend: BigInt(123)
        })
        await processNext(paymentId)

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        if (!payment.outcome) throw 'no outcome'
        expect(payment.state).toBe(PaymentState.Completed)
        expect(payment.outcome).toEqual({
          amountSent: payment.quote?.maxSourceAmount,
          amountDelivered: payment.quote?.minDeliveryAmount
        })
        expect(plugins[payment.sourceAccount.id].totalReceived).toBe(
          payment.outcome.amountDelivered
        )

        const progress = await paymentProgressService.get(paymentId)
        if (!progress) throw 'no payment progress'
        expect(progress.amountSent).toBe(payment.outcome.amountSent)
        expect(progress.amountDelivered).toBe(payment.outcome.amountDelivered)

        await expect(
          accountService.getAccountBalance(payment.sourceAccount.id)
        ).resolves.toEqual({ balance: BigInt(0) })
        await expect(
          accountService.getAccountBalance(superAccountId)
        ).resolves.toEqual({
          balance: BigInt(200) - payment.outcome.amountSent
        })
      })

      it('Completed (FixedDelivery)', async (): Promise<void> => {
        const paymentId = await setup({
          invoiceUrl: 'http://wallet.example/bob/invoices/1'
        })
        await processNext(paymentId)

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        if (!payment.quote) throw 'no quote'
        if (!payment.outcome) throw 'no outcome'
        expect(payment.state).toBe(PaymentState.Completed)
        expect(payment.outcome).toEqual({
          amountSent: payment.quote.minDeliveryAmount * BigInt(2),
          amountDelivered: payment.quote.minDeliveryAmount
        })
        expect(plugins[payment.sourceAccount.id].totalReceived).toBe(
          payment.outcome.amountDelivered
        )

        const progress = await paymentProgressService.get(paymentId)
        if (!progress) throw 'no payment progress'
        expect(progress.amountSent).toBe(payment.outcome.amountSent)
        expect(progress.amountDelivered).toBe(payment.outcome.amountDelivered)

        // The leftover money (56*2*slippage USD) has been refunded to the parent account.
        await expect(
          accountService.getAccountBalance(payment.sourceAccount.id)
        ).resolves.toEqual({ balance: BigInt(0) })
        await expect(
          accountService.getAccountBalance(superAccountId)
        ).resolves.toEqual({
          balance: BigInt(200) - payment.outcome.amountSent
        })
      })

      it('Completed (resume from full payment with failed commit)', async (): Promise<void> => {
        const paymentId = await setup({
          paymentPointer: 'http://wallet.example/paymentpointer/bob',
          amountToSend: BigInt(123)
        })
        await processNext(paymentId)

        // Pretend that the transaction didn't commit.
        await OutgoingPayment.query(knex)
          .findById(paymentId)
          .patch({
            state: PaymentState.Sending,
            outcome: {
              amountSent: BigInt(0),
              amountDelivered: BigInt(0)
            }
          })
        await processNext(paymentId)

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Completed)
        expect(payment.outcome).toEqual({
          amountSent: payment.quote?.maxSourceAmount,
          amountDelivered: payment.quote?.minDeliveryAmount
        })
        // The retry doesn't pay anything (this is the retry's plugin).
        expect(plugins[payment.sourceAccount.id].totalReceived).toBe(BigInt(0))
      })

      it('Sending (partial payment then retryable Pay error)', async (): Promise<void> => {
        jest.spyOn(Pay, 'pay').mockImplementation(async () => ({
          error: Pay.PaymentError.ClosedByReceiver,
          amountSent: BigInt(10),
          amountDelivered: BigInt(5),
          sourceAmountInFlight: BigInt(0),
          destinationAmountInFlight: BigInt(0)
        }))

        const paymentId = await setup({
          paymentPointer: 'http://wallet.example/paymentpointer/bob',
          amountToSend: BigInt(123)
        })

        for (let i = 0; i < 4; i++) {
          await processNext(paymentId)
          const payment = await OutgoingPayment.query(knex).findById(paymentId)
          expect(payment.state).toBe(PaymentState.Sending)
          expect(payment.error).toBeNull()
          expect(payment.attempts).toBe(i + 1)
        }
        // Last attempt fails, but no more retries.
        await processNext(paymentId)
        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe('ClosedByReceiver')
        expect(payment.attempts).toBe(0)
      })

      it('Cancelling (non-retryable Pay error)', async (): Promise<void> => {
        jest
          .spyOn(Pay, 'pay')
          .mockImplementation(async (opts: Pay.PayOptions) => {
            const progress = {
              error: Pay.PaymentError.ReceiverProtocolViolation,
              amountSent: BigInt(10),
              amountDelivered: BigInt(5),
              sourceAmountInFlight: BigInt(0),
              destinationAmountInFlight: BigInt(0)
            }
            if (opts.progressHandler) opts.progressHandler(progress)
            return progress
          })
        const paymentId = await setup({
          paymentPointer: 'http://wallet.example/paymentpointer/bob',
          amountToSend: BigInt(123)
        })

        await processNext(paymentId)
        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe('ReceiverProtocolViolation')
        // Not updated yet.
        expect(payment.outcome).toBeUndefined()

        const progress = await paymentProgressService.get(paymentId)
        if (!progress) throw 'no progress'
        expect(progress.amountSent).toBe(BigInt(10))
        expect(progress.amountDelivered).toBe(BigInt(5))
      })
    })

    describe('Cancelling→', (): void => {
      let paymentId: string
      beforeEach(
        async (): Promise<void> => {
          paymentId = (
            await outgoingPaymentService.create({
              superAccountId,
              paymentPointer: 'http://wallet.example/paymentpointer/bob',
              amountToSend: BigInt(123),
              autoApprove: true
            })
          ).id
        }
      )

      it('Cancelled (from Sending; restore reserved funds)', async (): Promise<void> => {
        jest
          .spyOn(Pay, 'pay')
          .mockImplementation(() =>
            Promise.reject(Pay.PaymentError.InvoiceAlreadyPaid)
          )
        for (let i = 0; i < 5; i++) await processNext(paymentId) // → Cancelled

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelled)
        expect(payment.error).toBe('InvoiceAlreadyPaid')
        expect(payment.outcome).toBeUndefined()
        // All reserved money was refunded.
        await expect(
          accountService.getAccountBalance(superAccountId)
        ).resolves.toEqual({ balance: BigInt(200) })
      })

      it('Cancelling (retries when refund fails)', async (): Promise<void> => {
        jest
          .spyOn(Pay, 'pay')
          .mockImplementation(() =>
            Promise.reject(Pay.PaymentError.InvoiceAlreadyPaid)
          )
        jest
          .spyOn(accountService, 'revokeCredit')
          .mockImplementation(() =>
            Promise.reject(new Error('account service error'))
          )
        // Even after many retries, if Cancelling fails it keeps retrying.
        for (let i = 0; i < 10; i++) await processNext(paymentId)

        const payment = await OutgoingPayment.query(knex).findById(paymentId)
        expect(payment.state).toBe(PaymentState.Cancelling)
        expect(payment.error).toBe('InvoiceAlreadyPaid')
      })
    })
  })

  describe('requote', (): void => {
    let payment: OutgoingPayment
    beforeEach(
      async (): Promise<void> => {
        payment = await outgoingPaymentService.create({
          superAccountId,
          paymentPointer: 'http://wallet.example/paymentpointer/bob',
          amountToSend: BigInt(123),
          autoApprove: false
        })
      }
    )

    it('requotes a Cancelled payment', async (): Promise<void> => {
      await payment.$query().patch({
        state: PaymentState.Cancelled,
        error: 'Fail'
      })
      await expect(
        outgoingPaymentService.requote(payment.id)
      ).resolves.toBeUndefined()

      const after = await OutgoingPayment.query(knex).findById(payment.id)
      expect(after.state).toBe(PaymentState.Inactive)
      expect(after.error).toBeNull()
    })

    it('does not requote a Cancelling payment', async (): Promise<void> => {
      await payment.$query().patch({
        state: PaymentState.Cancelling,
        error: 'Fail'
      })
      await expect(outgoingPaymentService.requote(payment.id)).rejects.toThrow(
        `Cannot quote; payment is in state=Cancelling`
      )

      const after = await OutgoingPayment.query(knex).findById(payment.id)
      expect(after.state).toBe(PaymentState.Cancelling)
      expect(after.error).toBe('Fail')
    })
  })

  describe('activate', (): void => {
    let payment: OutgoingPayment
    beforeEach(
      async (): Promise<void> => {
        payment = await outgoingPaymentService.create({
          superAccountId,
          paymentPointer: 'http://wallet.example/paymentpointer/bob',
          amountToSend: BigInt(123),
          autoApprove: false
        })
        await processNext(payment.id)
      }
    )

    it('activates a Ready payment', async (): Promise<void> => {
      await outgoingPaymentService.activate(payment.id)

      const after = await OutgoingPayment.query(knex).findById(payment.id)
      expect(after.state).toBe(PaymentState.Activated)
    })

    it('does not activate an Inactive payment', async (): Promise<void> => {
      await payment.$query().patch({ state: PaymentState.Inactive })
      await expect(outgoingPaymentService.activate(payment.id)).rejects.toThrow(
        `Cannot activate; payment is in state=Inactive`
      )

      const after = await OutgoingPayment.query(knex).findById(payment.id)
      expect(after.state).toBe(PaymentState.Inactive)
    })
  })

  describe('cancel', (): void => {
    let payment: OutgoingPayment
    beforeEach(
      async (): Promise<void> => {
        payment = await outgoingPaymentService.create({
          superAccountId,
          paymentPointer: 'http://wallet.example/paymentpointer/bob',
          amountToSend: BigInt(123),
          autoApprove: false
        })
      }
    )

    it('cancels a Ready payment', async (): Promise<void> => {
      await payment.$query().patch({ state: PaymentState.Ready })
      await outgoingPaymentService.cancel(payment.id)

      const after = await OutgoingPayment.query(knex).findById(payment.id)
      expect(after.state).toBe(PaymentState.Cancelling)
      expect(after.error).toBe('CancelledByAPI')
    })

    it('does not cancel an Inactive payment', async (): Promise<void> => {
      await expect(outgoingPaymentService.activate(payment.id)).rejects.toThrow(
        `Cannot cancel; payment is in state=Inactive`
      )

      const after = await OutgoingPayment.query(knex).findById(payment.id)
      expect(after.state).toBe(PaymentState.Inactive)
    })
  })
})
