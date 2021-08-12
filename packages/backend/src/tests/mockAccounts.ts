import { v4 as uuid } from 'uuid'
import { Account } from '../account/model'

type FakeAccount = {
  id: string
  scale: number
  currency: string
  superAccountId?: string
  _balance: bigint
}

export class MockAccountService {
  public data: { [key: string]: FakeAccount } = {}

  async create(scale: number, currency: string): Promise<Account> {
    const id = uuid()
    const account = {
      id,
      scale,
      currency,
      _balance: BigInt(0)
    }
    this.data[id] = account
    return (account as unknown) as Account
  }

  async createIlpSubAccount(superAccountId: string): Promise<Account> {
    const parent = this._get(superAccountId)
    const id = uuid()
    const account = {
      id,
      scale: parent.scale,
      currency: parent.currency,
      superAccountId,
      _balance: BigInt(0)
    }
    this.data[id] = account
    return (account as unknown) as Account
  }

  async extendCredit(
    accountId: string,
    amount: bigint
  ): Promise<string | undefined> {
    const account = this._get(accountId)
    if (!account.superAccountId) return 'UnknownSubAccount'
    const parent = this._get(account.superAccountId)
    if (parent._balance < amount) return 'InsufficientBalance'
    parent._balance -= amount
    account._balance += amount
  }

  async revokeCredit(
    accountId: string,
    amount: bigint
  ): Promise<string | undefined> {
    const account = this._get(accountId)
    if (!account.superAccountId) return 'UnknownSubAccount'
    const parent = this._get(account.superAccountId)
    if (account._balance < amount) return 'InsufficientBalance'
    parent._balance += amount
    account._balance -= amount
  }

  async getAccountBalance(accountId: string): Promise<{ balance: bigint }> {
    return { balance: this._get(accountId)._balance }
  }

  // For testing
  setAccountBalance(accountId: string, balance: bigint): void {
    this._get(accountId)._balance = balance
  }

  modifyAccountBalance(accountId: string, diff: bigint): boolean {
    const account = this._get(accountId)
    const newBalance = account._balance + diff
    if (newBalance < 0) return false
    account._balance += diff
    return true
  }

  _get(accountId: string): FakeAccount {
    const account = this.data[accountId]
    if (!account) throw new Error('no account')
    return account
  }
}
