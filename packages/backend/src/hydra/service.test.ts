import { IocContract } from '@adonisjs/fold'
import { AppServices } from '../app'
import { createTestApp, TestContainer } from '../tests/app'
import { initIocContainer } from '..'
import { Config } from '../config/app'
import { HydraService } from './service'

describe('Hydra Service', (): void => {
  let deps: IocContract<AppServices>
  let appContainer: TestContainer
  let hydraService: HydraService

  const clientDetails = {
    client_id: 'test-client',
    client_name: 'test-client',
    scope: 'openid,offline',
    response_types: ['token', 'code', 'id_token'],
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: ['http://localhost:3000/callback'],
    logo_uri: 'http://localhost:3000/logo'
  }

  beforeAll(
    async (): Promise<void> => {
      deps = await initIocContainer(Config)
      appContainer = await createTestApp(deps)
      hydraService = await deps.use('hydraService')
    }
  )

  afterAll(
    async (): Promise<void> => {
      await appContainer.shutdown()
    }
  )

  describe('Create Client', (): void => {
    test('Can create new oauth client', async (): Promise<void> => {
      const client = await hydraService.createOauthClient(clientDetails)
      expect(client.client_id).toEqual(clientDetails.client_id)
      expect(client).toHaveProperty('client_secret')
    })
  })

  describe('Introspect', (): void => {
    test('Random token is inactive', async (): Promise<void> => {
      const token =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      const info = await hydraService.introspectToken(token)
      expect(info).toEqual({ active: false })
    })
  })
})
