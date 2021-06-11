import EventEmitter from 'events'
import * as crypto from 'crypto'
import * as http from 'http'
import { v4 as uuid } from 'uuid'
import Knex, { Transaction as KnexTransaction } from 'knex'
import { Model } from 'objection'
import createLogger from 'pino'
import Koa, { Middleware } from 'koa'
import { Ioc } from '@adonisjs/fold'
import httpMocks from 'node-mocks-http'
import { StreamServer } from '@interledger/stream-receiver'
import { Config } from '../../config/app'
import { AppContainer, AppContext, AppContextData } from '../../app'
import { makeSPSPHandler } from '../../services/spsp'
import { User } from '../../models'

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:password@localhost:5432/testing'
const knex = Knex({
  client: 'postgresql',
  connection: DATABASE_URL,
  pool: {
    min: 2,
    max: 10
  },
  migrations: {
    tableName: 'knex_migrations'
  }
})

describe('SPSP handler', function () {
  const container: AppContainer = new Ioc()
  container.singleton('config', async () => Config)
  container.singleton('knex', async () => knex)
  const nonce = crypto.randomBytes(16).toString('base64')
  const secret = crypto.randomBytes(32).toString('base64')
  const next = async function () {
    // just to satisfy the types
    throw new Error('unreachable')
  }
  let handle: Middleware<unknown, AppContext>
  let server: http.Server
  let trx: KnexTransaction

  const streamServer = new StreamServer({
    serverSecret: Config.streamSecret,
    serverAddress: Config.ilpAddress
  })

  const ids = {
    ok: uuid(),
    disabled: uuid(),
    disabledStream: uuid()
  }
  const accounts = {
    [ids.ok]: {
      userId: uuid(),
      stream: { enabled: true },
      asset: { code: 'USD', scale: 9 }
    },
    [ids.disabled]: {
      userId: uuid(),
      disabled: true,
      stream: { enabled: true },
      asset: { code: 'USD', scale: 9 }
    },
    [ids.disabledStream]: {
      userId: uuid(),
      stream: { enabled: false },
      asset: { code: 'USD', scale: 9 }
    }
  }

  const koa = new Koa<unknown, AppContextData>()
  koa.use(async (ctx, _next) => {
    const match = /^\/ilp-accounts\/([\w-]+)$/.exec(ctx.request.path)
    if (!match || !accounts[match[1]]) return ctx.throw(404)
    ctx.body = accounts[match[1]]
  })

  beforeAll(async () => {
    handle = await makeSPSPHandler(container)
    server = koa.listen(3456)
  })

  beforeEach(async () => {
    trx = await knex.transaction()
    Model.knex(trx)
    for (const accountId of Object.keys(accounts)) {
      await User.query().insert({ id: accounts[accountId].userId, accountId })
    }
  })

  afterEach(async () => {
    await trx.rollback()
    await trx.destroy()
  })

  afterAll(async () => {
    server.close()
    await knex.destroy()
  })

  test('invalid account id; returns 400', async () => {
    const ctx = createContext(ids.ok, {})
    ctx.params.id = 'not_a_uuid'
    await expect(handle(ctx, next)).rejects.toHaveProperty('status', 400)
  })

  test('wrong Accept; returns 406', async () => {
    const ctx = createContext(ids.ok, {
      headers: { Accept: 'application/json' }
    })
    await expect(handle(ctx, next)).rejects.toHaveProperty('status', 406)
  })

  test('nonce, no secret; returns 400', async () => {
    const ctx = createContext(ids.ok, {
      headers: { 'Receipt-Nonce': nonce }
    })
    await expect(handle(ctx, next)).rejects.toHaveProperty('status', 400)
  })

  test('secret; no nonce; returns 400', async () => {
    const ctx = createContext(ids.ok, {
      headers: { 'Receipt-Secret': secret }
    })
    await expect(handle(ctx, next)).rejects.toHaveProperty('status', 400)
  })

  test('malformed nonce; returns 400', async () => {
    const ctx = createContext(ids.ok, {
      headers: {
        'Receipt-Nonce': Buffer.alloc(15).toString('base64'),
        'Receipt-Secret': secret
      }
    })
    await expect(handle(ctx, next)).rejects.toHaveProperty('status', 400)
  })

  test('no account; returns 404', async () => {
    const ctx = createContext(ids.ok, {})
    ctx.params.id = uuid()
    await expect(handle(ctx, next)).resolves.toBeUndefined()
    expect(ctx.response.status).toBe(404)
    expect(ctx.response.get('Content-Type')).toBe('application/spsp4+json')
    expect(JSON.parse(ctx.body as string)).toEqual({
      id: 'InvalidReceiverError',
      message: 'Invalid receiver ID'
    })
  })

  test('disabled account; returns 404', async () => {
    const ctx = createContext(ids.disabled, {})
    await expect(handle(ctx, next)).resolves.toBeUndefined()
    expect(ctx.response.status).toBe(404)
    expect(ctx.response.get('Content-Type')).toBe('application/spsp4+json')
    expect(JSON.parse(ctx.body as string)).toEqual({
      id: 'InvalidReceiverError',
      message: 'Invalid receiver ID'
    })
  })

  test('disabled stream; returns 400', async () => {
    const ctx = createContext(ids.disabledStream, {})
    await expect(handle(ctx, next)).rejects.toHaveProperty('status', 400)
  })

  test('receipts disabled', async () => {
    const ctx = createContext(ids.ok, {})
    await expect(handle(ctx, next)).resolves.toBeUndefined()
    expect(ctx.response.get('Content-Type')).toBe('application/spsp4+json')

    const res = JSON.parse(ctx.body as string)
    expect(res.destination_account).toEqual(
      expect.stringMatching(/^test\.rafiki\.[a-zA-Z0-9_-]{95}$/)
    )
    expect(Buffer.from(res.shared_secret, 'base64')).toHaveLength(32)
    expect(res.receipts_enabled).toBe(false)
    expect(decryptConnectionDetails(res.destination_account)).toEqual({
      paymentTag: ids.ok,
      asset: {
        code: 'USD',
        scale: 9
      }
    })
  })

  test('receipts enabled', async () => {
    const ctx = createContext(ids.ok, {
      headers: {
        'Receipt-Nonce': nonce,
        'Receipt-Secret': secret
      }
    })
    await expect(handle(ctx, next)).resolves.toBeUndefined()
    expect(ctx.response.get('Content-Type')).toBe('application/spsp4+json')

    const res = JSON.parse(ctx.body as string)
    expect(ctx.status).toBe(200)
    expect(res.destination_account).toEqual(
      expect.stringMatching(/^test\.rafiki\.[a-zA-Z0-9_-]{159}$/)
    )
    expect(Buffer.from(res.shared_secret, 'base64')).toHaveLength(32)
    expect(res.receipts_enabled).toBe(true)
    expect(decryptConnectionDetails(res.destination_account)).toEqual({
      paymentTag: ids.ok,
      asset: {
        code: 'USD',
        scale: 9
      },
      receiptSetup: {
        nonce: Buffer.from(nonce, 'base64'),
        secret: Buffer.from(secret, 'base64')
      }
    })
  })

  function createContext(
    accountId: string,
    reqOpts: httpMocks.RequestOptions
  ): AppContext {
    reqOpts.headers = Object.assign(
      { accept: 'application/spsp4+json' },
      reqOpts.headers
    )
    const req = httpMocks.createRequest(reqOpts)
    const res = httpMocks.createResponse()
    const ctx = koa.createContext(req, res)
    ctx.params = { id: accounts[accountId].userId }
    ctx.container = container
    ctx.logger = createLogger()
    ctx.closeEmitter = new EventEmitter()
    return ctx as AppContext
  }

  function decryptConnectionDetails(destination: string): unknown {
    const token = streamServer['extractLocalAddressSegment'](destination)
    return streamServer['decryptToken'](Buffer.from(token, 'base64'))
  }
})
