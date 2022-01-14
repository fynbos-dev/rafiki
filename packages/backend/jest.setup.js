// eslint-disable-next-line @typescript-eslint/no-var-requires
const Knex = require('knex')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GenericContainer, Wait, Network } = require('testcontainers')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tmp = require('tmp')

const POSTGRES_PORT = 5432

const TIGERBEETLE_CLUSTER_ID = 1
const TIGERBEETLE_PORT = 3004
const TIGERBEETLE_DIR = '/var/lib/tigerbeetle'

const REDIS_PORT = 6379

const HYDRA_PUBLIC_PORT = 4444
const HYDRA_ADMIN_PORT = 4445

module.exports = async (globalConfig) => {
  const workers = globalConfig.maxWorkers

  if (!process.env.DATABASE_URL) {
    const postgresContainer = await new GenericContainer('postgres')
      .withExposedPorts(POSTGRES_PORT)
      .withBindMount(
        __dirname + '/scripts/init.sh',
        '/docker-entrypoint-initdb.d/init.sh'
      )
      .withEnv('POSTGRES_PASSWORD', 'password')
      .start()

    process.env.DATABASE_URL = `postgresql://postgres:password@localhost:${postgresContainer.getMappedPort(
      POSTGRES_PORT
    )}/testing`

    global.__BACKEND_POSTGRES__ = postgresContainer
  }

  const knex = Knex({
    client: 'postgresql',
    connection: process.env.DATABASE_URL,
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      tableName: 'knex_migrations'
    }
  })

  // node pg defaults to returning bigint as string. This ensures it parses to bigint
  knex.client.driver.types.setTypeParser(
    knex.client.driver.types.builtins.INT8,
    'text',
    BigInt
  )
  await knex.migrate.latest({
    directory: './packages/backend/migrations'
  })

  for (let i = 1; i <= workers; i++) {
    const workerDatabaseName = `testing_${i}`

    await knex.raw(`DROP DATABASE IF EXISTS ${workerDatabaseName}`)
    await knex.raw(`CREATE DATABASE ${workerDatabaseName} TEMPLATE testing`)
  }

  global.__BACKEND_KNEX__ = knex

  if (!process.env.TIGERBEETLE_REPLICA_ADDRESSES) {
    const { name: tigerbeetleDir } = tmp.dirSync({ unsafeCleanup: true })

    await new GenericContainer(
      'ghcr.io/coilhq/tigerbeetle@sha256:0d8cd6b7a0a7f7ef678c6fc877f294071ead642698db2a438a6599a3ade8fb6f'
    )
      .withExposedPorts(TIGERBEETLE_PORT)
      .withBindMount(tigerbeetleDir, TIGERBEETLE_DIR)
      .withCmd([
        'init',
        '--cluster=' + TIGERBEETLE_CLUSTER_ID,
        '--replica=0',
        '--directory=' + TIGERBEETLE_DIR
      ])
      .withWaitStrategy(Wait.forLogMessage(/initialized data file/))
      .start()

    const tigerbeetleContainer = await new GenericContainer(
      'ghcr.io/coilhq/tigerbeetle@sha256:0d8cd6b7a0a7f7ef678c6fc877f294071ead642698db2a438a6599a3ade8fb6f'
    )
      .withExposedPorts(TIGERBEETLE_PORT)
      .withBindMount(tigerbeetleDir, TIGERBEETLE_DIR)
      .withCmd([
        'start',
        '--cluster=' + TIGERBEETLE_CLUSTER_ID,
        '--replica=0',
        '--addresses=0.0.0.0:' + TIGERBEETLE_PORT,
        '--directory=' + TIGERBEETLE_DIR
      ])
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .start()

    process.env.TIGERBEETLE_CLUSTER_ID = TIGERBEETLE_CLUSTER_ID
    process.env.TIGERBEETLE_REPLICA_ADDRESSES = `[${tigerbeetleContainer.getMappedPort(
      TIGERBEETLE_PORT
    )}]`
    global.__BACKEND_TIGERBEETLE__ = tigerbeetleContainer
  }

  if (!process.env.REDIS_URL) {
    const redisContainer = await new GenericContainer('redis')
      .withExposedPorts(REDIS_PORT)
      .start()

    global.__BACKEND_REDIS__ = redisContainer
    process.env.REDIS_URL = `redis://localhost:${redisContainer.getMappedPort(
      REDIS_PORT
    )}`
  }

  if (!process.env.HYDRA_PUBLIC_URL || !process.env.HYDRA_ADMIN_URL) {
    const hydraNetwork = await new Network().start()

    const hydraContainer = await new GenericContainer(
      'oryd/hydra:v1.10.6-sqlite'
    )
      .withNetworkMode(hydraNetwork.getName())
      .withName('hydra')
      .withExposedPorts(HYDRA_PUBLIC_PORT, HYDRA_ADMIN_PORT)
      .withEnv('SECRETS_SYSTEM', 'mysupersecretsecret')
      .withEnv('DSN', 'memory')
      .withEnv('URLS_SELF_ISSUER', `http://localhost:${HYDRA_PUBLIC_PORT}/`) //TODO: need to make sure this is correct
      .withEnv('URLS_CONSENT', 'http://localhost:9020/consent') //TODO: update port
      .withEnv('URLS_LOGIN', 'http://localhost:9020/login') //TODO: update port
      .withCmd(['serve', 'all', '--dangerous-force-http'])
      .start()

    global.__BACKEND_HYDRA__ = hydraContainer
    process.env.HYDRA_PUBLIC_URL = `http://localhost:${hydraContainer.getMappedPort(
      HYDRA_PUBLIC_PORT
    )}`
    process.env.HYDRA_ADMIN_URL = `http://localhost:${hydraContainer.getMappedPort(
      HYDRA_ADMIN_PORT
    )}`

    // Create client
    new GenericContainer('oryd/hydra:v1.10.6-sqlite')
      .withNetworkMode(hydraNetwork.getName())
      .withEnv('HYDRA_ADMIN_URL', `http://hydra:${HYDRA_ADMIN_PORT}`)
      .withCmd([
        'clients',
        'create',
        '--skip-tls-verify',
        '--id',
        'frontend-client',
        '--secret',
        'secret',
        '--token-endpoint-auth-method',
        'none',
        '--grant-types',
        'authorization_code,refresh_token',
        '--response-types',
        'token,code,id_token',
        '--scope',
        'openid,offline',
        '--callbacks',
        'http://localhost:3000/callback' // TODO: update port
      ])
      .start()
  }
}
