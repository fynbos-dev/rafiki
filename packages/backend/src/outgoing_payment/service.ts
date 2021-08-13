import * as Pay from '@interledger/pay'
import { RatesService } from 'rates'
import { BaseService } from '../shared/baseService'
import { OutgoingPayment, PaymentIntent, PaymentState } from './model'
import { AccountService } from '../account/service'
import { PaymentProgressService } from '../payment_progress/service'
import { IlpPlugin } from './ilp_plugin'
import * as lifecycle from './lifecycle'
import * as worker from './worker'

import { Account } from '../account/model' // XXX

// TODO ilpPlugin MUST disconnect() to prevent memory leaks (in lifecycle.ts too) (use .finally()?)
// TODO stream receipts

interface TmpAccountService extends AccountService {
  // XXX
  createIlpSubAccount(superAccountId: string): Promise<Account>
  extendCredit(accountId: string, amount: bigint): Promise<string | undefined>
  revokeCredit(accountId: string, amount: bigint): Promise<string | undefined>
  getAccountBalance(accountId: string): Promise<{ balance: bigint }>
}

export interface OutgoingPaymentService {
  get(id: string): Promise<OutgoingPayment>
  create(options: CreateOutgoingPaymentOptions): Promise<OutgoingPayment>
  activate(id: string): Promise<void>
  cancel(id: string): Promise<void>
  requote(id: string): Promise<void>
  processNext(): Promise<string | undefined>
}

export interface ServiceDependencies extends BaseService {
  slippage: number
  quoteLifespan: number // milliseconds
  accountService: TmpAccountService
  ratesService: RatesService
  //ilpPlugin: IlpPlugin
  makeIlpPlugin: (sourceAccount: string) => IlpPlugin
  paymentProgressService: PaymentProgressService
}

export async function createOutgoingPaymentService(
  deps_: ServiceDependencies
): Promise<OutgoingPaymentService> {
  const deps = {
    ...deps_,
    logger: deps_.logger.child({ service: 'OutgoingPaymentService' })
  }
  return {
    get: (id) => getOutgoingPayment(deps, id),
    create: (options: CreateOutgoingPaymentOptions) =>
      createOutgoingPayment(deps, options),
    activate: (id) => activatePayment(deps, id),
    cancel: (id) => cancelPayment(deps, id),
    requote: (id) => requotePayment(deps, id),
    processNext: () => worker.processPendingPayment(deps)
  }
}

async function getOutgoingPayment(
  deps: ServiceDependencies,
  id: string
): Promise<OutgoingPayment> {
  return OutgoingPayment.query(deps.knex).findById(id)
}

type CreateOutgoingPaymentOptions = PaymentIntent & { superAccountId: string }

async function createOutgoingPayment(
  deps: ServiceDependencies,
  options: CreateOutgoingPaymentOptions
): Promise<OutgoingPayment> {
  const destination = await Pay.setupPayment({
    plugin: deps.makeIlpPlugin(options.superAccountId),
    paymentPointer: options.paymentPointer,
    invoiceUrl: options.invoiceUrl
  })

  const sourceAccount = await deps.accountService.createIlpSubAccount(
    options.superAccountId
  )

  return await OutgoingPayment.query(deps.knex).insertAndFetch({
    state: PaymentState.Inactive,
    intent: {
      paymentPointer: options.paymentPointer,
      invoiceUrl: options.invoiceUrl,
      amountToSend: options.amountToSend,
      autoApprove: options.autoApprove
    },
    sourceAccount: {
      id: sourceAccount.id,
      code: sourceAccount.currency,
      scale: sourceAccount.scale
    },
    destinationAccount: {
      scale: destination.destinationAsset.scale,
      code: destination.destinationAsset.code,
      url: destination.accountUrl,
      paymentPointer: destination.paymentPointer
    }
  })
}

function requotePayment(deps: ServiceDependencies, id: string): Promise<void> {
  return deps.knex.transaction(async (trx) => {
    const payment = await OutgoingPayment.query(trx).findById(id).forUpdate()
    if (payment.state !== PaymentState.Cancelled) {
      throw new Error(`Cannot quote; payment is in state=${payment.state}`)
    }
    await payment.$query(trx).patch({ state: PaymentState.Inactive })
  })
}

async function activatePayment(
  deps: ServiceDependencies,
  id: string
): Promise<void> {
  return deps.knex.transaction(async (trx) => {
    const payment = await OutgoingPayment.query(trx).findById(id).forUpdate()
    if (payment.state !== PaymentState.Ready) {
      throw new Error(`Cannot activate; payment is in state=${payment.state}`)
    }
    await payment.$query(trx).patch({ state: PaymentState.Activated })
  })
}

async function cancelPayment(
  deps: ServiceDependencies,
  id: string
): Promise<void> {
  return deps.knex.transaction(async (trx) => {
    const payment = await OutgoingPayment.query(trx).findById(id).forUpdate()
    if (payment.state !== PaymentState.Ready) {
      throw new Error(`Cannot cancel; payment is in state=${payment.state}`)
    }
    await payment.$query(trx).patch({
      state: PaymentState.Cancelling,
      error: lifecycle.LifecycleError.CancelledByAPI
    })
  })
}
