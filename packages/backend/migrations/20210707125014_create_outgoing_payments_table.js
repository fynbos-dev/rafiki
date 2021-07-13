exports.up = function (knex) {
  return knex.schema.createTable('outgoingPayments', function (table) {
    table.uuid('id').notNullable().primary()
    // TODO userId

    table.string('state').notNullable() // PaymentState
    table.string('error').nullable()

    table.string('intentPaymentPointer').nullable()
    table.string('intentInvoiceUrl').nullable()
    table.bigInteger('intentAmountToSend').nullable()
    table.boolean('intentAutoApprove').notNullable()

    table.timestamp('quoteTimestamp').nullable()
    table.timestamp('quoteActivationDeadline').nullable()
    table.string('quoteTargetType').nullable() // 'fixed-send' | 'fixed-delivery'
    table.bigint('quoteMinDeliveryAmount').nullable()
    table.bigint('quoteMaxSourceAmount').nullable()
    table.float('quoteMinExchangeRate').nullable()
    table.float('quoteLowExchangeRateEstimate').nullable()
    table.float('quoteHighExchangeRateEstimate').nullable()
    table.integer('quoteEstimatedDuration').nullable() // milliseconds

    table.integer('sourceAccountScale').notNullable()
    table.string('sourceAccountCode').notNullable()
    table.integer('destinationAccountScale').notNullable()
    table.string('destinationAccountCode').notNullable()
    table.string('destinationAccountUrl').notNullable()
    table.string('destinationAccountPaymentPointer').notNullable()

    table.bigint('outcomeAmountSent').nullable()
    table.bigint('outcomeSourceAmountInFlight').nullable()
    table.bigint('outcomeAmountDelivered').nullable()
    table.bigint('outcomeDestinationAmountInFlight').nullable()
    // TODO streamReceipts

    table.timestamp('createdAt').defaultTo(knex.fn.now())
    table.timestamp('updatedAt').defaultTo(knex.fn.now())
  })
}

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('outgoingPayments')
}
